// Background process behind `call` and `run`: one tool set (one KVM session) per card, kept
// between CLI invocations, served on a unix socket next to the session file.
//
// Why: every CLI invocation used to open and close its own KVM session. That is slow, the card
// needs seconds before it accepts the next session, and in HID power-save mode (see kvm.js) each
// new first session costs the keyboard wait again. With the daemon the session stays open, and
// screen_ids from one `call` are still valid in the next.
//
//   megarac-mcp daemon <host>          run in the foreground (what `call` starts on demand)
//   megarac-mcp daemon <host> status   is one running?
//   megarac-mcp daemon <host> stop     end it (closes the KVM session)
//
// It exits by itself after MEGARAC_DAEMON_IDLE minutes without a call (default 10), so the KVM
// control is free again for the browser viewer. Protocol: HTTP on the socket, JSON bodies:
//   GET /status -> {version, host, pid, busy}
//   POST /call {tool, args} -> the tool's MCP result ({content, isError})
//   POST /stop
// The socket is mode 600 in a directory only the user can enter: whoever can reach it could
// already read the session tokens beside it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionFile } from './session.js';
import { createTools, flagsFromEnv, bmcFromEnv, VERSION } from './tools.js';
import { callTool } from './cli.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = (host) => path.dirname(sessionFile(host));
export const socketPath = (host) => path.join(stateDir(host), `${host}.sock`);
export const logPath = (host) => path.join(stateDir(host), `${host}.daemon.log`);

/** Run the daemon for one card. Returns { listening, finished, shutdown }. */
export function serve({ host, env = process.env, bmc = null, idleMs = Math.max(0.1, +(env.MEGARAC_DAEMON_IDLE ?? 10)) * 60000, log = (m) => process.stderr.write(`[megarac-mcp ${new Date().toISOString()}] ${m}\n`) }) {
  const { tools, close } = createTools({ bmc: bmc || bmcFromEnv(host, env), flags: flagsFromEnv(env), log });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const sock = socketPath(host);
  let chain = Promise.resolve(), busy = 0, lastUse = Date.now(), done;
  const finished = new Promise((r) => { done = r; });

  const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      lastUse = Date.now();
      if (req.method === 'GET' && req.url === '/status') return send(res, 200, { version: VERSION, host, pid: process.pid, busy });
      if (req.method === 'POST' && req.url === '/stop') { send(res, 200, { stopping: true }); return void shutdown('stop requested'); }
      if (req.method !== 'POST' || req.url !== '/call') return send(res, 404, { error: 'unknown request' });
      busy++;
      chain = chain.then(async () => {          // one tool call at a time: they share the KVM session
        let out;
        try {
          const { tool, args } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          out = await callTool(byName, tool, args);
        } catch (e) { out = { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
        busy--; lastUse = Date.now();
        send(res, 200, out);
      });
    });
  });

  let closing = false;
  async function shutdown(why) {
    if (closing) return; closing = true;
    log(`daemon for ${host} exiting: ${why}`);
    clearInterval(idleTimer);
    server.close();
    try { await close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sock); } catch { /* ignore */ }
    done();
  }
  const idleTimer = setInterval(() => { if (!busy && Date.now() - lastUse > idleMs) shutdown('idle'); }, Math.min(15000, idleMs / 2));
  const onSignal = () => shutdown('signal');
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);

  fs.mkdirSync(stateDir(host), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(sock); } catch { /* ignore */ }
  const umask = process.umask(0o077);
  const listening = new Promise((res, rej) => { server.once('error', rej); server.listen(sock, () => { process.umask(umask); log(`daemon for ${host} listening on ${sock}`); res(); }); });
  return { listening, finished, shutdown };
}

/** One request to a running daemon. Rejects when none is listening. */
export function request(host, method, url, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socketPath(host), method, path: url, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error(`daemon sent no JSON: ${e.message}`)); } });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export const status = (host) => request(host, 'GET', '/status').catch(() => null);

/** Make sure a daemon of this version runs for the host; start one if not. */
export async function ensureDaemon(host, { env = process.env } = {}) {
  let st = await status(host);
  if (st && st.version !== VERSION) { await request(host, 'POST', '/stop').catch(() => {}); await sleep(500); st = null; }
  if (st) return st;
  bmcFromEnv(host, env);                         // no credentials: fail here, with the usual message
  fs.mkdirSync(stateDir(host), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath(host), 'a', 0o600);
  const bin = fileURLToPath(new URL('../bin/megarac-mcp.js', import.meta.url));
  spawn(process.execPath, [bin, 'daemon', host], { detached: true, stdio: ['ignore', logFd, logFd], env }).unref();
  fs.closeSync(logFd);
  for (let i = 0; i < 100; i++) { await sleep(100); if ((st = await status(host))) return st; }
  throw new Error(`the background process for ${host} did not start; see ${logPath(host)} (or use --no-daemon)`);
}

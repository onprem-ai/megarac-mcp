#!/usr/bin/env node
// megarac-mcp                       run the MCP server (stdio)
// megarac-mcp login <host>          ask for the password once, store only session tokens
// megarac-mcp logout <host>         end the sessions on the card and delete the token file
// megarac-mcp call <host> <tool> …  call one tool without an MCP client (see src/cli.js)
// megarac-mcp run <host> steps.json run several tool calls in one session
// megarac-mcp tools                 list the tools
// megarac-mcp daemon <host> [status|stop]  background process that keeps the KVM session for call/run
await import('../src/env.js'); // ASUS_IPMI_* variables from before the rename still work
const [cmd, host, ...rest] = process.argv.slice(2);
const fatal = (e) => { process.stderr.write(`[megarac-mcp] ${e.message || e}\n`); process.exit(1); };

if (cmd === 'login' || cmd === 'logout') {
  const ui = rest.indexOf('--user');
  const user = ui >= 0 ? rest[ui + 1] : (process.env.MEGARAC_USER || 'admin');
  const { login, logout } = await import('../src/session.js');
  (cmd === 'login' ? login({ host, user }) : logout({ host })).catch(fatal);
} else if (cmd === 'call' || cmd === 'run' || cmd === 'tools' || cmd === 'daemon') {
  const { cli } = await import('../src/cli.js');
  // Exit explicitly: undici keep-alive sockets would otherwise hold the process open.
  cli(process.argv.slice(2)).then((code) => process.exit(code), fatal);
} else if (cmd === '-h' || cmd === '--help') {
  process.stdout.write(`usage:
  megarac-mcp                                    MCP server on stdio (MEGARAC_HOST=<host>)
  megarac-mcp login <host> [--user <user>]       store session tokens (asks for the password once)
  megarac-mcp logout <host>                      end the sessions, delete the token file
  megarac-mcp tools                              list tools
  megarac-mcp call <host> <tool> ['<json>'] [--out <file>]
  megarac-mcp run <host> <steps.json|-> [--out-dir <dir>] [--keep-going]
  megarac-mcp daemon <host> [status|stop]        background process behind call/run (started on demand)
`);
} else {
  const { main } = await import('../src/server.js');
  main().catch((e) => {
    process.stderr.write(`[megarac-mcp] fatal: ${e.stack || e}\n`);
    process.exit(1);
  });
}

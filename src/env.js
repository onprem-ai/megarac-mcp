// The project was called asus-ipmi-mcp before it was renamed to megarac-mcp, and its variables
// ASUS_IPMI_*. Existing configs keep working: every ASUS_IPMI_X is read as MEGARAC_X unless
// MEGARAC_X is set too.
const OLD = 'ASUS_IPMI_', NEW = 'MEGARAC_';

export function withOldNames(env = process.env) {
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(OLD) && env[NEW + k.slice(OLD.length)] === undefined) env[NEW + k.slice(OLD.length)] = v;
  }
  return env;
}

withOldNames();

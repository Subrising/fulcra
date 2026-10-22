// FU-467: Node flags for the processes that agents start with the Orca node binary (the supervisor inbox and the
// canonical memory MCP servers, and the Claude API key helper). The daemon decides the flags (packagedInspectorFlags,
// FU-466) and hands them to the controller child in this variable. control/ does not import @getpaseo/server.
// Only two values are accepted: exactly ["--disable-sigusr1"] or [] (the gate flavour). Anything else (other flags,
// extra entries, wrong types, bad JSON, missing value) gives ["--disable-sigusr1"], so the variable can never put
// --require or --inspect into a server's argv.
export const NODE_FLAGS_ENV = "ORCA_NODE_FLAGS";
const DEFAULT_FLAGS = ["--disable-sigusr1"];

export function mcpNodeFlags(env = process.env) {
  const raw = env[NODE_FLAGS_ENV];
  if (raw === undefined) return [...DEFAULT_FLAGS];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_FLAGS];
  }
  if (Array.isArray(parsed) && parsed.length === 0) return [];
  return [...DEFAULT_FLAGS];
}

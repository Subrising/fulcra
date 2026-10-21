// FU-467: Node flags for the MCP server processes that agents start (the supervisor inbox and the canonical memory
// server). The daemon decides the flags (packagedInspectorFlags, FU-466) and hands them to the controller child in
// this variable. control/ does not import @getpaseo/server. A missing or malformed value fails closed: no SIGUSR1
// inspector. A valid empty list (the gate flavour) gives no flag.
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
  if (!Array.isArray(parsed) || parsed.some((flag) => typeof flag !== "string"))
    return [...DEFAULT_FLAGS];
  return parsed.filter((flag) => flag.length > 0);
}

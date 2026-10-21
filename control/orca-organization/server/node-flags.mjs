// FU-467: the plugin-local copy of control/src/control/mcp-node-flags.mjs for the Claude API key helper. The plugin
// bundle cannot import files outside its own tree, so the rule is copied here. It must stay identical: a parity test in
// control/src/control/mcp-node-flags.test.mjs compares both copies. Only exactly ["--disable-sigusr1"] or [] (the gate
// flavour) is accepted; anything else gives ["--disable-sigusr1"].
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

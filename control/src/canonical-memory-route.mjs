import { fileURLToPath } from "node:url";
import { portable } from "./portable-config.mjs";
import { mcpNodeFlags } from "./control/mcp-node-flags.mjs";
export const CANONICAL_MEMORY_ENTRY = fileURLToPath(
  new URL("./portable-memory/entry.mjs", import.meta.url),
);
export function verifyCanonicalMemory() {
  return { root: portable.memoryRoot };
}
export function canonicalMemoryConfig(provider) {
  if (!["claude", "codex"].includes(provider)) throw Error("Known memory provider required");
  return {
    type: "stdio",
    command: process.execPath,
    args: [...mcpNodeFlags(), CANONICAL_MEMORY_ENTRY],
    env: { ELECTRON_RUN_AS_NODE: "1", ORCA_HOME: portable.home, ORCA_MEMORY_CLIENT: provider },
  };
}

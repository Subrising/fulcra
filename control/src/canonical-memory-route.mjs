import { fileURLToPath } from 'node:url';
import { portable } from './portable-config.mjs';
export function verifyCanonicalMemory() { return { root: portable.memoryRoot }; }
export function canonicalMemoryConfig(provider) {
  if (!['claude', 'codex'].includes(provider)) throw Error('Known memory provider required');
  return { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./portable-memory/entry.mjs', import.meta.url))], env: { ELECTRON_RUN_AS_NODE: '1', ORCA_HOME: portable.home, ORCA_MEMORY_CLIENT: provider } };
}

import { packagedInspectorFlags } from "../src/server/inspector-flavour.js";

/**
 * Node arguments for a packaged daemon worker that starts through the entry point runner. The runner is the
 * script, so the inspector flags must come before it. Without them a release worker opens a Node inspector on
 * SIGUSR1 (FU-79; the gap was found by the FU-413 release check).
 */
export function packagedWorkerSpawnArgs(
  runner: string,
  workerEntry: string,
  workerArgs: readonly string[],
): string[] {
  return [...packagedInspectorFlags(), runner, "node-script", workerEntry, ...workerArgs];
}

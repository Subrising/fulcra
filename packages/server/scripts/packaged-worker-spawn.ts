import { packagedInspectorFlags } from "../src/server/inspector-flavour.js";

export interface PackagedWorkerSpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * How a packaged supervisor starts its daemon worker: through the entry point runner, in Electron Node mode. The
 * runner is the script, so the inspector flags must come before it. Without them a release worker opens a Node
 * inspector on SIGUSR1 (FU-79; the gap was found by the FU-413 release check).
 */
export function packagedWorkerSpawnSpec(
  runner: string,
  workerEntry: string,
  workerArgs: readonly string[],
  env: NodeJS.ProcessEnv,
): PackagedWorkerSpawnSpec {
  return {
    command: process.execPath,
    args: [...packagedInspectorFlags(), runner, "node-script", workerEntry, ...workerArgs],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

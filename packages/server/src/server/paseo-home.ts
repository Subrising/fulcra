import os from "node:os";
import path from "node:path";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  // FULCRA_HOME is the Fulcra name; PASEO_HOME still works so upstream setups keep their home.
  const raw = env.FULCRA_HOME ?? env.PASEO_HOME ?? "~/.paseo";
  const resolved = path.resolve(expandHomeDir(raw));
  return resolved;
}

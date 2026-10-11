import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * macOS registers a process that runs an app bundle's main executable as a Foreground app: a Dock icon
 * (shown as "exec") and a Force Quit entry, also in Electron node mode. The bundle's Helper app is
 * LSUIElement, so a daemon that runs through it is never listed. Returns the Helper for a main bundle
 * executable, or null when the process already runs through something else.
 */
export function resolveBackgroundExecPath(input: {
  execPath: string;
  platform: NodeJS.Platform;
  exists: (filePath: string) => boolean;
}): string | null {
  if (input.platform !== "darwin") return null;
  const macosDir = path.posix.dirname(input.execPath);
  const contentsDir = path.posix.dirname(macosDir);
  if (path.posix.basename(macosDir) !== "MacOS" || path.posix.basename(contentsDir) !== "Contents")
    return null;
  const bundleDir = path.posix.dirname(contentsDir);
  // A Helper bundle is already LSUIElement.
  if (!bundleDir.endsWith(".app") || bundleDir.endsWith(" Helper.app")) return null;
  const name = path.posix.basename(input.execPath);
  const helper = path.posix.join(
    contentsDir,
    "Frameworks",
    `${name} Helper.app`,
    "Contents",
    "MacOS",
    `${name} Helper`,
  );
  return input.exists(helper) ? helper : null;
}

// Before anything else: replace this process image with the Helper. The PID stays, so launchd, the
// CLI and the desktop app still track the same process.
function becomeBackgroundProcess(): void {
  const helper = resolveBackgroundExecPath({
    execPath: process.execPath,
    platform: process.platform,
    exists: existsSync,
  });
  if (!helper || typeof process.execve !== "function") return;
  process.execve(helper, [helper, ...process.argv.slice(1)], process.env);
}

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

if (require.main === module) {
  becomeBackgroundProcess();
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

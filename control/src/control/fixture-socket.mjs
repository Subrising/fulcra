import fs from "node:fs";
import path from "node:path";
// Test support, shared so the next socket-bearing fixture cannot repeat the mistake.
// macOS caps a unix socket path (sun_path) at 104 bytes and fails with a bare EINVAL. A fixture home under
// a stock macOS TMPDIR (/var/folders/<2>/<30>/T) is already ~48 bytes before realpath prepends /private, so
// a nested fixture overruns quietly. /tmp realpaths to /private/tmp on macOS and to itself on Linux, which
// is what docs/cross-mac-fence.md already recommends for these suites.
export const SUN_PATH_MAX = 104;
export const shortCanonicalBase = (prefix) =>
  fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), prefix)));
export function bindable(socket) {
  const bytes = Buffer.byteLength(socket);
  // Fail naming the measurement rather than EINVAL if a future path change creeps back over the limit.
  if (bytes > SUN_PATH_MAX)
    throw new Error(
      `fixture socket path is ${bytes} bytes, over the ${SUN_PATH_MAX}-byte sun_path limit: ${socket}`,
    );
  return socket;
}

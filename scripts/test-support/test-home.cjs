// e2e and CI scripts start real apps and daemons. Started on a live home, they take its agents, sockets
// and lock. A test home is a directory under the OS temp directory, or one that a script created for the
// run and marked. Every script that starts an app or daemon asserts this first.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_HOME_MARKER = ".fulcra-test-home";

function realpathOfNearest(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isTestHome(home) {
  if (typeof home !== "string" || !path.isAbsolute(home)) return false;
  const resolved = realpathOfNearest(home);
  const temps = [os.tmpdir(), "/tmp"].filter((dir) => fs.existsSync(dir)).map(realpathOfNearest);
  if (temps.some((temp) => isInside(resolved, temp))) return true;
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, TEST_HOME_MARKER))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

function assertTestHome(home, what) {
  if (isTestHome(home)) return;
  throw new Error(
    `Refusing to start ${what}: PASEO_HOME ${home} is not a test home. Use a directory under ` +
      `${os.tmpdir()}, or one this run created and marked with ${TEST_HOME_MARKER}.`,
  );
}

// Only for a directory the caller just created empty for this run (for example with mkdtemp).
function markTestRoot(directory) {
  fs.writeFileSync(path.join(directory, TEST_HOME_MARKER), "", { flag: "wx" });
}

module.exports = { TEST_HOME_MARKER, isTestHome, assertTestHome, markTestRoot };

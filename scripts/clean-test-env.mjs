/**
 * A test run must not depend on the shell that starts it. A Fulcra chat exports FULCRA_* settings
 * (Command Centre mode, ledger folder, usage guards) and PASEO_* values that name the live daemon.
 * Tests that read these fail, or touch live state. This helper removes them before tests start.
 */

// Daemon identity values that a chat inherits from the live daemon.
const LIVE_DAEMON_VARIABLES = new Set([
  "PASEO_HOME",
  "PASEO_LISTEN",
  "PASEO_DAEMON_SERVER_ID",
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
  "PASEO_AGENT_CALLER_WITNESS",
]);

// Variables that a test run sets on purpose. FULCRA_TEST_* is always kept.
// Name more variables in FULCRA_TEST_KEEP_ENV, separated by commas.
function isAllowed(name, env) {
  if (name.startsWith("FULCRA_TEST_")) return true;
  const extra = (env.FULCRA_TEST_KEEP_ENV ?? "").split(",").map((entry) => entry.trim());
  return extra.includes(name);
}

/** Remove leaked variables from env. Return the names that were removed. */
export function cleanTestEnv(env = process.env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    const leaked = name.startsWith("FULCRA_") || LIVE_DAEMON_VARIABLES.has(name);
    if (leaked && !isAllowed(name, env)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

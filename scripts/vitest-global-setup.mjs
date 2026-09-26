/**
 * Vitest resolves @getpaseo/protocol through its `exports` map to `dist`, so a stale build
 * fails suites with errors that look like code defects. npm's `pretest` hook cannot cover
 * this: the usual way to run one suite is `npx vitest run <file>`, which never invokes an
 * npm script. A global setup runs on every invocation, including that one.
 */
import ensureProtocolBuild from "./ensure-protocol-build.mjs";

export default function setup() {
  ensureProtocolBuild();
}

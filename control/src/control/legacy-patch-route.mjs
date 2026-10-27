// The staged-patch route (stage-native-turn.mjs, native-release-hooks.mjs) rewrites a compiled server dist at fixed text
// anchors. A product build that already carries the trusted plugin hooks (its stop() runs
// trustedPlugins.shutdownClosure) no longer has those anchors, and the route cannot patch it. Tests that patch a
// pristine dist read this to skip, with the reason, instead of failing on an anchor the product removed on purpose.
import fs from "node:fs";
import path from "node:path";
import baseTest from "node:test";
export function retiredPatchRoute(source) {
  const bootstrap = fs.readFileSync(path.join(source, "bootstrap.js"), "utf8");
  return bootstrap.includes("await closeAllAgents(logger, agentManager);")
    ? false
    : "this product build has the trusted plugin hooks; the legacy staged-patch anchors are retired";
}
// node:test's test(), with the skip decided once for the whole file.
export const testUnless = (skip) => (name, options, fn) =>
  typeof options === "function"
    ? baseTest(name, { skip }, options)
    : baseTest(name, { skip, ...options }, fn);

import test from "node:test";
import assert from "node:assert/strict";
import { releasePaths } from "./release-paths.mjs";

test("release tooling paths come from the configured installation, and a bad config is refused plainly", () => {
  assert.deepEqual(releasePaths({ installation: "/opt/fulcra", home: "/opt/fulcra/home" }), {
    admissionBase: "/opt/fulcra/node_modules/@getpaseo/server/dist/server/server/agent/",
    daemonPid: "/opt/fulcra/home/paseo.pid",
    daemonSecret: "/opt/fulcra/home/controller.secret",
  });
  for (const bad of [{}, { installation: "fulcra", home: "/h" }, { installation: "/i" }])
    assert.throws(() => releasePaths(bad), /config\/runtime\.json needs an absolute/);
  // Portable releases intentionally have no machine-specific config/runtime.json.
  if (!fs.existsSync(new URL("../../config/runtime.json", import.meta.url)))
    assert.throws(() => releasePaths(), /ENOENT/);
});

import fs from "node:fs";
import path from "node:path";
import { inScope } from "../../tools/portable-scope.mjs";
const retiredDependencyTools = [
  "dependency-pins.mjs",
  "dependency-pins.test.mjs",
  "dependency-prepare.py",
  "dependency-switch-test.py",
];
test("retired tools are absent while retained repair imports remain available", () => {
  assert(
    fs.existsSync(new URL("../dependency-switch.py", import.meta.url)),
    "live overlay/deploy repair dependency",
  );
  assert.equal(inScope("src/dependency-switch.py"), false);
  for (const name of retiredDependencyTools)
    assert.equal(fs.existsSync(new URL("../" + name, import.meta.url)), false, name);
});
test(
  "the actual packaged host/controller graph uses the in-tree SDK, without legacy patch tooling",
  { skip: !process.env.FULCRA_TEST_PACKAGED_APP && "Requires staged app resources" },
  () => {
    const bundle = path.join(
      process.env.FULCRA_TEST_PACKAGED_APP,
      "Contents/Resources/bundled-plugins/orca-organization-next",
    );
    for (const filename of ["controller.mjs", "index.host.js"]) {
      const inputs = JSON.parse(fs.readFileSync(path.join(bundle, filename + ".inputs.json")));
      assert(
        inputs.some((input) => /packages\/(?:client|plugin|protocol)\/dist\//.test(input)),
        filename + " needs the in-tree SDK",
      );
      assert(
        !inputs.some((input) =>
          /dependency-(?:pins|switch|prepare)|native-release-hooks|deploy-admission|permission-overlay|stage-native-turn|src\/book\/stage|control\/activation(?:-preflight)?\.mjs/.test(
            input,
          ),
        ),
        "legacy route entered bundle",
      );
      assert(fs.statSync(path.join(bundle, filename)).size > 0);
    }
    assert.equal(
      inScope("src/control/deploy-readiness.mjs"),
      false,
      "legacy deployment checks are not a shipped entrypoint",
    );
  },
);

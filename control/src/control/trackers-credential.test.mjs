// J3 credential CLI (J3-DESIGN.md §3.1, mutation M6). A fake `security` runner stands in for the keychain.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  credentialCommand,
  manifestPluginId,
  runCredential,
  SERVICE,
  serviceFor,
  LEGACY_SERVICE,
} from "./trackers-credential.mjs";
const CANARY = "CANARY-cli-" + "z".repeat(20);

test("K1: set prompts through security with -w last and no value; no token is ever in argv", () => {
  const calls = [];
  const out = runCredential("set", "github", undefined, (file, args, opts) => {
    calls.push({ file, args, opts });
  });
  assert.deepEqual(calls[0].args, [
    "add-generic-password",
    "-U",
    "-s",
    SERVICE,
    "-a",
    "github.com:read",
    "-w",
  ]);
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.equal(calls[0].opts.stdio, "inherit");
  assert.deepEqual(out, { tracker: "github", account: "github.com:read", stored: true });
});

test("K2: status reports presence only; it never reads the secret, and prints nothing security returned", () => {
  const args = credentialCommand("status", "github");
  assert.equal(args.includes("-w"), false);
  assert.equal(args.includes("-g"), false);
  let seen;
  const present = runCredential("status", "github", undefined, (file, a, opts) => {
    seen = opts;
    return a.includes("-w") ? CANARY + "\n" : "attributes only";
  });
  assert.deepEqual(present, { tracker: "github", account: "github.com:read", present: true });
  assert.deepEqual(seen.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(JSON.stringify(present).includes(CANARY), false);
  const absent = runCredential("status", "jira", "acme.atlassian.net", () => {
    const e = new Error("SecKeychainSearchCopyNext: not found");
    e.status = 44;
    throw e;
  });
  assert.deepEqual(absent, {
    tracker: "jira",
    account: "jira:acme.atlassian.net:read",
    present: false,
  });
  assert.throws(
    () =>
      runCredential("status", "github", undefined, () => {
        const e = new Error(CANARY);
        e.status = 1;
        throw e;
      }),
    (e) => !e.message.includes(CANARY),
  );
});

test("K3: only read accounts in the plugin namespace are addressable", () => {
  assert.deepEqual(credentialCommand("delete", "bitbucket").slice(-4), [
    "-s",
    SERVICE,
    "-a",
    "bitbucket.org:read",
  ]);
  assert.throws(() => credentialCommand("status", "jira", "evil.example"), /Invalid tracker site/);
  assert.throws(() => credentialCommand("status", "gitlab"), /Unknown tracker/);
  assert.throws(() => credentialCommand("show", "github"), /Usage/);
});

test("K4: the namespace follows the plugin runtime installation id, validated, defaulting to the manifest id", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../orca-organization/paseo-plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(manifestPluginId(), manifest.id);
  assert.equal(SERVICE, `ai.fulcra.plugin.${manifest.id}`);
  assert.equal(
    SERVICE,
    "ai.fulcra.plugin.orca-organization-next",
    "the installed plugin reads this namespace",
  );
  assert.equal(serviceFor("orca-staging"), "ai.fulcra.plugin.orca-staging");
  assert.throws(() => manifestPluginId(() => "{}"), /manifest has no id/);
  assert.deepEqual(
    credentialCommand("status", "github", undefined, serviceFor("orca-staging")).slice(1, 3),
    ["-s", "ai.fulcra.plugin.orca-staging"],
  );
  for (const bad of ["", "Upper", "../x", "a b", "-s"])
    assert.throws(() => serviceFor(bad), /Invalid plugin id/);
});

test("K5 (J0-5): status finds an orphan under the old name by presence only, and delete-legacy removes only that", () => {
  const calls = [],
    missing = () => {
      const e = new Error("not found");
      e.status = 44;
      throw e;
    };
  const exec = (file, args) => {
    calls.push(args);
    if (!args.includes(LEGACY_SERVICE)) missing();
    return args.includes("-w") || args.includes("-g") ? CANARY : "attributes only";
  };
  const out = runCredential("status", "github", undefined, exec);
  assert.deepEqual(out, {
    tracker: "github",
    account: "github.com:read",
    present: false,
    legacy: true,
    hint: "A token was saved under the old name, where Fulcra cannot read it. Run set again, then delete-legacy",
  });
  assert.deepEqual(calls, [
    ["find-generic-password", "-s", SERVICE, "-a", "github.com:read"],
    ["find-generic-password", "-s", LEGACY_SERVICE, "-a", "github.com:read"],
  ]);
  assert.ok(
    calls.every((a) => !a.includes("-w") && !a.includes("-g")),
    "the secret is never read",
  );
  assert.equal(JSON.stringify(out).includes(CANARY), false);
  // Nothing anywhere: plainly missing, no hint.
  assert.deepEqual(
    runCredential("status", "github", undefined, () => missing()),
    { tracker: "github", account: "github.com:read", present: false },
  );
  assert.equal(LEGACY_SERVICE, "ai.fulcra.plugin.orca-organization");
  assert.notEqual(SERVICE, LEGACY_SERVICE);
  assert.deepEqual(credentialCommand("delete-legacy", "jira", "acme.atlassian.net"), [
    "delete-generic-password",
    "-s",
    LEGACY_SERVICE,
    "-a",
    "jira:acme.atlassian.net:read",
  ]);
  const deleted = [];
  assert.deepEqual(
    runCredential("delete-legacy", "bitbucket", undefined, (f, a) => {
      deleted.push(a);
    }),
    { tracker: "bitbucket", account: "bitbucket.org:read", deleted: true },
  );
  assert.deepEqual(deleted, [
    ["delete-generic-password", "-s", LEGACY_SERVICE, "-a", "bitbucket.org:read"],
  ]);
  assert.throws(() => runCredential("status-legacy", "github", undefined, () => {}), /Usage/);
});

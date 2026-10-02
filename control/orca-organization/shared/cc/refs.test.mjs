// CONTRACTS §1a / §2.1 / §3.2 #9: the shared refs, personal-data and plain-language checks the controller and
// the plugin both run. v1.5 requires every implementation to keep the "low-risk-first" regression.
import test from "node:test";
import assert from "node:assert/strict";
import { noPersonal, personalMatch, parseRef, plainLanguageCheck } from "./refs.mjs";

test('§1a v1.5: ordinary words that contain a token prefix are not secrets ("low-risk-first" regression)', () => {
  for (const text of [
    "Go with the low-risk-first option",
    "A low-risk-first rollout keeps customers safe.",
    "We can ask-first before each change.",
    "Our desk-based team reviews it.",
    "A task-level check",
    "Whisk-ready",
  ])
    assert.equal(personalMatch(text), null, text);
});

test("§1a: real tokens, paths, private hosts and emails are refused", () => {
  const token = "abcdEFGH1234_-xyz";
  for (const text of [
    `key sk-${token}`,
    `ghp_${token}`,
    `gho_${token}`,
    `github_pat_${token}`,
    `xoxb-${token}`,
    `(sk-${token})`,
  ])
    assert.equal(personalMatch(text), "a secret token", text);
  assert.equal(personalMatch("see ~/notes"), "a home or volume path");
  assert.equal(personalMatch("the build-box.local host"), "a private host name");
  assert.equal(personalMatch("mail someone@example.com"), "an email address");
  assert.equal(noPersonal("The practice copy is ready."), true);
});

test("§2.1 and §3.2 #9: one parser, and plain language flags ids and jargon but not English", () => {
  assert.deepEqual(parseRef("pr:github:acme/app#17"), {
    kind: "pr",
    repoKey: "github:acme/app",
    number: 17,
  });
  for (const bad of [
    "file:github:acme/app:../etc",
    "file:github:acme/app:src/../../etc",
    "file:github:acme/app:/etc/passwd",
  ])
    assert.equal(parseRef(bad), null, bad);
  assert.deepEqual(parseRef("file:github:acme/app:src/..x/ok.ts"), {
    kind: "file",
    repoKey: "github:acme/app",
    path: "src/..x/ok.ts",
  });
  assert.deepEqual(plainLanguageCheck("A low-risk-first rollout keeps customers safe."), []);
  assert.match(plainLanguageCheck("The webhook failed").join(), /webhook/);
});

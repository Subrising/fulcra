import test from "node:test";
import assert from "node:assert/strict";
import {
  validMapping,
  validItemRef,
  canonicalUrl,
  itemKey,
  displayRef,
  credentialAccount,
  plainText,
} from "./tracker-refs.mjs";

test("R1: canonical URLs are built from the pinned mapping only, per tracker", () => {
  assert.equal(
    canonicalUrl("github", "github.com", "Subrising/fulcra", "12"),
    "https://github.com/Subrising/fulcra/issues/12",
  );
  assert.equal(
    canonicalUrl("jira", "acme.atlassian.net", "ORCA", "ORCA-12"),
    "https://acme.atlassian.net/browse/ORCA-12",
  );
  assert.equal(
    canonicalUrl("bitbucket", "bitbucket.org", "team/repo", "3"),
    "https://bitbucket.org/team/repo/issues/3",
  );
  for (const args of [
    ["github", "evil.example", "a/b", "1"],
    ["github", "github.com", "a/..", "1"],
    ["github", "github.com", "a/b", "1/../x"],
    ["jira", "acme.atlassian.net", "ORCA", "OTHER-1"],
    ["jira", "evil.com", "ORCA", "ORCA-1"],
    ["bitbucket", "bitbucket.org", "Team/Repo", "1"],
  ]) {
    assert.throws(() => canonicalUrl(...args), /Invalid tracker reference/, args.join(" "));
  }
});
test("R2: mapping identities, item refs and keys are strict", () => {
  assert.equal(
    validMapping({
      tracker: "github",
      auth: "gh-cli",
      site: "github.com",
      remoteId: "1",
      remoteName: "a/b",
    }),
    true,
  );
  assert.equal(
    validMapping({
      tracker: "jira",
      auth: "gh-cli",
      site: "acme.atlassian.net",
      remoteId: "1",
      remoteName: "ORCA",
    }),
    false,
  );
  assert.equal(
    validMapping({
      tracker: "bitbucket",
      auth: "keychain",
      site: "bitbucket.org",
      remoteId: "{00000000-0000-4000-8000-000000002003}",
      remoteName: "team/repo",
    }),
    true,
  );
  assert.equal(
    validMapping({
      tracker: "github",
      auth: "keychain",
      site: "github.com",
      remoteId: "01",
      remoteName: "a/b",
    }),
    false,
  );
  assert.equal(validItemRef("github", "a/b", "0"), false);
  assert.equal(validItemRef("github", "a/b", "10000000000"), false);
  assert.equal(
    itemKey("bitbucket", "{00000000-0000-4000-8000-000000002003}", "4"),
    "bitbucket:00000000-0000-4000-8000-000000002003:4",
  );
  assert.equal(displayRef("github", "4"), "#4");
  assert.equal(displayRef("jira", "ORCA-4"), "ORCA-4");
});
test("R3: credential accounts are fixed read accounts; no write account is derivable", () => {
  assert.equal(credentialAccount("github", "github.com"), "github.com:read");
  assert.equal(credentialAccount("jira", "acme.atlassian.net"), "jira:acme.atlassian.net:read");
  assert.equal(credentialAccount("bitbucket", "bitbucket.org"), "bitbucket.org:read");
  assert.throws(() => credentialAccount("github", "evil.example"), /Invalid tracker site/);
});
test("R4: tracker text is plain, one line, without controls or bidi overrides, and capped", () => {
  assert.equal(plainText("a\u202eb\u2066c\u0000d\r\ne\u200bf", 64), "abcd ef");
  assert.equal(
    plainText("<img src=x onerror=alert(1)> [github.com](https://evil)", 200),
    "<img src=x onerror=alert(1)> [github.com](https://evil)",
  );
  assert.equal(plainText("x".repeat(300), 256).length, 256);
  assert.ok(plainText("x".repeat(300), 256).endsWith("…"));
  assert.equal(plainText("\ud800ok", 10), "�ok");
  assert.equal(plainText(7, 10), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  recentPullRequests,
  changeDestination,
  changeTarget,
  checkoutFolder,
  addFolderProblem,
  readChangeWorkspaces,
} from "./changes-model.mjs";
const now = Date.parse("2026-09-27T00:00:00Z");
const entry = (n, state, days, kind = "pr") => ({
  item: {
    kind,
    key: `pr:github:example/shop#${n}`,
    title: "Example change",
    state,
    url: `https://github.com/example/shop/pull/${n}`,
  },
  trail: [{ kind: "state", label: "merged", at: new Date(now - days * 86400000).toISOString() }],
});
test("open PRs and merge events within exactly fourteen days; no closed issues, future or unknown dates", () => {
  const unknown = entry(8, "merged", 1);
  unknown.trail = [];
  const rows = [
    entry(1, "open", 100),
    entry(2, "merged", 14),
    entry(3, "merged", 14.01),
    entry(4, "merged", -1),
    entry(5, "closed", 1),
    entry(6, "open", 1, "issue"),
    unknown,
  ];
  assert.deepEqual(
    recentPullRequests(rows, now).map((e) => e.item.key),
    [rows[0].item.key, rows[1].item.key],
  );
});
test("joins by repository identity, never project name or PR number alone", () => {
  const item = entry(17, "open", 1).item;
  assert.equal(
    changeDestination(item, [
      { id: "wrong", gitRuntime: { remoteUrl: "https://github.com/example/other" } },
    ]),
    null,
  );
  assert.deepEqual(
    changeDestination(item, [
      {
        id: "worktree",
        workspaceKind: "worktree",
        gitRuntime: { remoteUrl: "git@github.com:example/shop.git" },
      },
      {
        id: "root",
        workspaceKind: "local_checkout",
        gitRuntime: { remoteUrl: "https://github.com/example/shop.git" },
      },
    ]),
    { workspaceId: "root", pullRequest: 17 },
  );
});

test("refuses mismatched PR URLs instead of navigating to a different change", () => {
  const item = entry(17, "open", 1).item;
  const workspaces = [
    { id: "root", gitRuntime: { remoteUrl: "https://github.com/example/shop.git" } },
  ];
  assert.equal(
    changeDestination({ ...item, url: "https://github.com/example/shop/pull/99" }, workspaces),
    null,
  );
  assert.equal(changeDestination({ ...item, key: "pr:github:example/other#17" }, workspaces), null);
});

test("reads workspace pages and refuses a repeated cursor", async () => {
  const seen = [];
  const result = await readChangeWorkspaces(async (input) => {
    seen.push(input.page.cursor);
    return input.page.cursor
      ? { entries: [{ id: "second" }], pageInfo: { hasMore: false, nextCursor: null } }
      : { entries: [{ id: "first" }], pageInfo: { hasMore: true, nextCursor: "next" } };
  });
  assert.deepEqual(
    result.entries.map((w) => w.id),
    ["first", "second"],
  );
  assert.deepEqual(seen, [undefined, "next"]);
  await assert.rejects(
    () =>
      readChangeWorkspaces(async () => ({
        entries: [],
        pageInfo: { hasMore: true, nextCursor: "loop" },
      })),
    /incomplete/,
  );
});

test("U5-D12: every PR has a state up front: ready, no-checkout (with its repository) or unreadable; a chosen checkout counts", () => {
  const item = entry(17, "open", 1).item;
  const fork = { id: "fork", gitRuntime: { remoteUrl: "https://github.com/me/shop.git" } };
  assert.deepEqual(changeTarget(item, [fork]), {
    state: "no-checkout",
    repo: "github.com/example/shop",
    pullRequest: 17,
  });
  assert.deepEqual(changeTarget(item, [fork], new Map([["github.com/example/shop", "fork"]])), {
    state: "ready",
    repo: "github.com/example/shop",
    workspaceId: "fork",
    pullRequest: 17,
  });
  assert.deepEqual(
    changeTarget(item, [], new Map([["github.com/example/shop", "gone"]])).state,
    "no-checkout",
  );
  assert.deepEqual(
    changeTarget({ ...item, url: "https://github.com/example/shop/pull/99" }, [fork]),
    { state: "unreadable" },
  );
  assert.deepEqual(changeTarget({ ...item, url: "not a url" }, [fork]), { state: "unreadable" });
});
test("U5-D12: the folder to add is a host path; failures become plain words", () => {
  assert.equal(checkoutFolder("  /Users/me/code/shop "), "/Users/me/code/shop");
  assert.equal(checkoutFolder("~/code/shop"), "~/code/shop");
  assert.equal(checkoutFolder("C:\\code\\shop"), "C:\\code\\shop");
  for (const bad of [
    "",
    "   ",
    "shop",
    "https://github.com/example/shop",
    "/a\nb",
    "/" + "x".repeat(1024),
  ])
    assert.equal(checkoutFolder(bad), null, bad);
  assert.match(
    addFolderProblem(Error("Missing permission workspace.manage")),
    /cannot add workspaces/,
  );
  assert.match(addFolderProblem(Error("ENOENT: no such file or directory")), /does not exist/);
  assert.equal(
    addFolderProblem(Error("boom /secret/path")),
    "That folder could not be added. Check the path, then try again.",
  );
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArchitectureChange,
  directoriesToCheck,
  mapTextAtCommit,
  pullRequestReadable,
  type ChangedFile,
} from "./architecture-change";
import { assessStaleness, hasTestBeside, SIGNIFICANT_FILES } from "./change-summary";
import { gitDiff } from "./git-patch.test.helpers";

const MAP = ".fulcra/architecture/shop.ir.json";
const base = readFileSync(join(__dirname, "fixtures", "change-base.ir.json"), "utf8");
const head = readFileSync(join(__dirname, "fixtures", "change-head.ir.json"), "utf8");
const file = (path: string, isDeleted = false): ChangedFile => ({ path, isDeleted });

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("a pull request compared at its own commits", () => {
  const prInput = (
    maps: Parameters<typeof buildArchitectureChange>[0]["pullRequestMaps"],
    headText: string | null = head,
  ) => ({
    mapPath: MAP,
    headText,
    mapDiff: gitDiff(base, head),
    changedFiles: [file(MAP)],
    siblings: new Map<string, string[]>(),
    pullRequest: { number: 17 },
    pullRequestMaps: maps,
  });

  it("compares exactly the texts read at the merge base and the head", () => {
    const change = buildArchitectureChange(prInput({ kind: "ok", base, head }));
    if (change.kind !== "ready") throw new Error(JSON.stringify(change));
    expect(change.comparison.touched).toEqual(["orders", "reports", "search"]);
    expect(change.pullRequest).toEqual({ number: 17 });
  });

  it("ignores dirty local edits: the working-tree text and diff never change the result", () => {
    const clean = buildArchitectureChange(prInput({ kind: "ok", base, head }));
    const edited = JSON.parse(head);
    edited.meta.title = "Edited on this computer, not committed";
    edited.components.push({
      ...edited.components[0],
      id: "local-only-part",
      label: "Not committed",
    });
    const dirty = buildArchitectureChange({
      ...prInput({ kind: "ok", base, head }, JSON.stringify(edited, null, 2)),
      mapDiff: gitDiff(base, JSON.stringify(edited, null, 2)),
    });
    expect(dirty).toEqual(clean);
    if (dirty.kind !== "ready") throw new Error(JSON.stringify(dirty));
    expect(dirty.head?.title).not.toContain("Edited on this computer");
    expect(dirty.head?.nodes.map((node) => node.id)).not.toContain("local-only-part");
  });

  it("a map missing at one commit is added or removed; missing at both is said plainly", () => {
    const added = buildArchitectureChange(prInput({ kind: "ok", base: null, head }));
    if (added.kind !== "ready") throw new Error(JSON.stringify(added));
    expect(added.base).toBeNull();
    expect(added.head?.nodes.map((node) => node.id)).toContain("search");
    const removed = buildArchitectureChange(prInput({ kind: "ok", base, head: null }));
    if (removed.kind !== "ready") throw new Error(JSON.stringify(removed));
    expect(removed.head).toBeNull();
    expect(buildArchitectureChange(prInput({ kind: "ok", base: null, head: null }))).toEqual({
      kind: "unavailable",
      reason: "not-in-pull-request",
      detail: [],
    });
  });

  it("a failed or oversized read is reported, never replaced by local text", () => {
    for (const maps of [
      { kind: "unavailable" as const, reason: "commit-read" as const, detail: ["host refused"] },
      { kind: "unavailable" as const, reason: "too_large" as const, detail: [] },
      { kind: "unavailable" as const, reason: "pull-request" as const, detail: [] },
    ]) {
      expect(buildArchitectureChange(prInput(maps))).toEqual(maps);
    }
  });

  it("turns the host's answers into map text", () => {
    expect(mapTextAtCommit({ status: "missing", encoding: "none" })).toEqual({
      kind: "ok",
      text: null,
    });
    expect(mapTextAtCommit({ status: "ok", encoding: "utf-8", content: head })).toEqual({
      kind: "ok",
      text: head,
    });
    expect(mapTextAtCommit({ status: "ok", encoding: "base64", content: btoa('{"a":1}') })).toEqual(
      { kind: "ok", text: '{"a":1}' },
    );
    expect(mapTextAtCommit({ status: "too_large", encoding: "none" })).toMatchObject({
      kind: "unavailable",
      reason: "too_large",
    });
    expect(mapTextAtCommit({ status: "not_a_file", encoding: "none" })).toMatchObject({
      kind: "unavailable",
      reason: "commit-read",
    });
    expect(mapTextAtCommit({ status: "error", encoding: "none", error: "bad object" })).toEqual({
      kind: "unavailable",
      reason: "commit-read",
      detail: ["bad object"],
    });
  });

  it("reads at commits only when the host has the capability and the forge gave both commits", () => {
    const pr = { baseRefOid: SHA_A, headRefOid: SHA_B };
    expect(pullRequestReadable(true, pr)).toEqual({ base: SHA_A, head: SHA_B });
    expect(pullRequestReadable(false, pr)).toBeNull();
    expect(pullRequestReadable(true, null)).toBeNull();
    expect(pullRequestReadable(true, { baseRefOid: null, headRefOid: SHA_B })).toBeNull();
    expect(pullRequestReadable(true, { baseRefOid: SHA_A, headRefOid: "main" })).toBeNull();
    expect(pullRequestReadable(true, { baseRefOid: "A".repeat(40), headRefOid: SHA_B })).toBeNull();
  });
});

describe("buildArchitectureChange", () => {
  it("rebuilds before from after plus the branch diff, and compares them (a branch without a pull request)", () => {
    const change = buildArchitectureChange({
      mapPath: MAP,
      headText: head,
      mapDiff: gitDiff(base, head),
      changedFiles: [
        file(MAP),
        file("src/orders.ts"),
        file("src/search.ts"),
        file("docs/notes.md"),
      ],
      siblings: new Map([["src", ["orders.ts", "orders.test.ts", "search.ts"]]]),
      pullRequest: null,
    });
    if (change.kind !== "ready") throw new Error(JSON.stringify(change));
    expect(change.base?.nodes.map((node) => node.id)).toContain("reports");
    expect(change.head?.nodes.map((node) => node.id)).toContain("search");
    expect(change.comparison.touched).toEqual(["orders", "reports", "search"]);
    expect(change.comparison.reach).toEqual(["web"]);
    expect(change.staleness).toMatchObject({
      significant: false,
      mapUpdated: true,
      outOfDate: false,
    });
    expect(change.files).toEqual({ changed: 4, code: 2, withTests: 1, checked: 2 });
    expect(change.pullRequest).toBeNull();
  });

  // a pull request's Before/After is the maps at its own base and head
  // commits. The host cannot read a file at a commit yet, so nothing is
  // rebuilt from this computer's files.
  it("without the maps read at its commits, never rebuilds a pull request's comparison from local files", () => {
    const edited = JSON.parse(head);
    edited.meta.title = "Edited on this computer, not committed";
    const localHead = JSON.stringify(edited, null, 2);
    const cases = [
      { headText: localHead, mapDiff: gitDiff(base, head) },
      { headText: head, mapDiff: gitDiff(base, head) },
      { headText: localHead, mapDiff: null },
      { headText: null, mapDiff: null },
    ];
    for (const { headText, mapDiff } of cases) {
      const change = buildArchitectureChange({
        mapPath: MAP,
        headText,
        mapDiff,
        changedFiles: [file(MAP)],
        siblings: new Map(),
        pullRequest: { number: 17 },
      });
      expect(change).toEqual({ kind: "unavailable", reason: "pull-request", detail: [] });
    }
  });

  it("a map the branch did not touch is its own before, and the view can still warn it is stale", () => {
    const changedFiles = Array.from({ length: SIGNIFICANT_FILES }, (_, i) => file(`src/f${i}.ts`));
    const change = buildArchitectureChange({
      mapPath: MAP,
      headText: head,
      mapDiff: null,
      changedFiles,
      siblings: new Map(),
      pullRequest: null,
    });
    if (change.kind !== "ready") throw new Error(JSON.stringify(change));
    expect(change.comparison.unchangedMap).toBe(true);
    expect(change.staleness).toMatchObject({
      significant: true,
      mapUpdated: false,
      outOfDate: true,
      fileCount: 10,
    });
    expect(change.files.checked).toBe(0);
  });

  it("changing a file the map cites makes the change significant on its own", () => {
    expect(
      assessStaleness({ changedPaths: ["services.yaml"], cited: ["services.yaml"] }),
    ).toMatchObject({
      significant: true,
      citedChanged: ["services.yaml"],
      outOfDate: true,
    });
    expect(
      assessStaleness({ changedPaths: ["services.yaml", MAP], cited: ["services.yaml"] }).outOfDate,
    ).toBe(false);
    expect(
      assessStaleness({ changedPaths: ["README.md"], cited: ["services.yaml"] }).significant,
    ).toBe(false);
  });

  it("refuses to compare when the diff no longer matches the map, or a side cannot be read", () => {
    const stale = buildArchitectureChange({
      mapPath: MAP,
      headText: head.replace("Orders service", "Orders service (edited since)"),
      mapDiff: gitDiff(base, head),
      changedFiles: [file(MAP)],
      siblings: new Map(),
      pullRequest: null,
    });
    expect(stale).toMatchObject({ kind: "unavailable", reason: "mismatch" });
    const broken = buildArchitectureChange({
      mapPath: MAP,
      headText: "{ not json",
      mapDiff: null,
      changedFiles: [],
      siblings: new Map(),
      pullRequest: null,
    });
    expect(broken).toMatchObject({ kind: "unavailable", reason: "invalid" });
  });

  it("a map the branch deleted still shows what was there", () => {
    const change = buildArchitectureChange({
      mapPath: MAP,
      headText: null,
      mapDiff: { ...gitDiff(base, ""), isDeleted: true },
      changedFiles: [file(MAP, true)],
      siblings: new Map(),
      pullRequest: null,
    });
    if (change.kind !== "ready") throw new Error(JSON.stringify(change));
    expect(change.head).toBeNull();
    expect(change.comparison.components.removed).toHaveLength(6);
  });
});

describe("tests beside changed code", () => {
  it("counts only a test named after the file, in the same folder", () => {
    expect(hasTestBeside("src/cart.ts", ["cart.ts", "cart.test.ts"])).toBe(true);
    expect(hasTestBeside("src/cart.tsx", ["cart.spec.tsx"])).toBe(true);
    expect(hasTestBeside("src/cart.ts", ["cartography.test.ts", "other.test.ts"])).toBe(false);
  });

  it("lists each folder once, skips tests, deletions and other files, and stops at the cap", () => {
    expect(
      directoriesToCheck([
        file("a/x.ts"),
        file("a/y.ts"),
        file("a/y.test.ts"),
        file("b/z.ts", true),
        file("c/r.md"),
      ]),
    ).toEqual(["a"]);
    const many = Array.from({ length: 30 }, (_, i) => file(`d${String(i).padStart(2, "0")}/x.ts`));
    expect(directoriesToCheck(many)).toHaveLength(20);
  });
});

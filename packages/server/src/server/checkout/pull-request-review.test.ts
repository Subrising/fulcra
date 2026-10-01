import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubReviewArgs,
  latestDecision,
  readAdwReview,
  recordDecision,
  riskOf,
} from "./pull-request-review.js";

const HEAD = "a".repeat(40);
const file = (
  kind: "code" | "test" | "other",
  status: "added" | "modified" | "deleted",
  tests: number,
) => ({
  path: "x.ts",
  status,
  part: "p",
  kind,
  tests,
  nearestTests: [],
});

describe("pull request review facts", () => {
  it("rates risk from the blast radius: untested or removed code is HIGH, tests and docs LOW", () => {
    expect(riskOf(file("code", "modified", 0))).toBe("HIGH");
    expect(riskOf(file("code", "deleted", 3))).toBe("HIGH");
    expect(riskOf(file("code", "modified", 2))).toBe("NORMAL");
    expect(riskOf(file("test", "added", 0))).toBe("LOW");
    expect(riskOf(file("other", "modified", 0))).toBe("LOW");
  });

  it("finds ADW's review of exactly this head commit, and nothing for another head", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "adw-"));
    const change = path.join(home, "state", "shop-1", "changes", "20260929-search");
    mkdirSync(path.join(change, "reviews"), { recursive: true });
    writeFileSync(
      path.join(home, "state", "shop-1", "repo.json"),
      JSON.stringify({ remote: "https://github.com/Acme/Shop.git" }),
    );
    writeFileSync(
      path.join(change, "change.json"),
      JSON.stringify({ title: "Search", freeze: { head: HEAD } }),
    );
    writeFileSync(
      path.join(change, "verdict.json"),
      JSON.stringify({
        overall: "BLOCKED",
        tier: "R2",
        findings: [{ severity: "error", control: "tests", message: "Suite failed" }],
      }),
    );
    writeFileSync(
      path.join(change, "reviews", "claude.json"),
      JSON.stringify({
        verdict: "REQUEST_CHANGES",
        findings: [{ severity: "major", file: "src/a.ts", line: 12, summary: "Unbounded loop" }],
      }),
    );
    const review = await readAdwReview({
      remoteUrl: "git@github.com:acme/shop.git",
      headOid: HEAD,
      adwHome: home,
    });
    expect(review).toMatchObject({ changeId: "20260929-search", verdict: "BLOCKED", tier: "R2" });
    expect(review?.findings).toEqual([
      {
        severity: "major",
        message: "Unbounded loop",
        file: "src/a.ts",
        line: 12,
        source: "reviewer",
      },
      { severity: "error", message: "Suite failed", source: "tests" },
    ]);
    const other = await readAdwReview({
      remoteUrl: "https://github.com/acme/shop",
      headOid: "b".repeat(40),
      adwHome: home,
    });
    expect(other).toBeNull();
  });

  it("records decisions on this host and returns the latest for the pull request", async () => {
    const paseoHome = mkdtempSync(path.join(os.tmpdir(), "home-"));
    const base = { pullRequest: 44, headOid: HEAD, note: "", postedToGithub: false };
    await recordDecision({
      paseoHome,
      key: "/repo",
      decision: { ...base, decision: "comment", at: "2026-09-29T00:00:00Z" },
    });
    await recordDecision({
      paseoHome,
      key: "/repo",
      decision: { ...base, decision: "approve", note: "Looks right", at: "2026-09-29T01:00:00Z" },
    });
    await expect(
      latestDecision({ paseoHome, key: "/repo", pullRequest: 44 }),
    ).resolves.toMatchObject({ decision: "approve", note: "Looks right" });
    await expect(latestDecision({ paseoHome, key: "/other", pullRequest: 44 })).resolves.toBeNull();
  });

  it("builds the gh review command only from the decision and note", () => {
    expect(githubReviewArgs(44, "request_changes", " Fix it ")).toEqual([
      "pr",
      "review",
      "44",
      "--request-changes",
      "--body",
      "Fix it",
    ]);
    expect(githubReviewArgs(44, "approve", "")).toEqual(["pr", "review", "44", "--approve"]);
  });
});

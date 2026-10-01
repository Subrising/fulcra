import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckoutPullRequestReviewDecideRequest } from "@getpaseo/protocol/messages";
import { handlePullRequestReviewDecide } from "./pull-request-review-request.js";
import { latestDecision } from "./pull-request-review.js";

const REVIEWED = "a".repeat(40);
const MOVED = "b".repeat(40);

describe("pull request review decide", () => {
  it("posts the review pinned to the reviewed commit, never the head that moved after the person looked", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pr-decide-ws-"));
    const paseoHome = mkdtempSync(path.join(os.tmpdir(), "pr-decide-home-"));
    const calls: string[][] = [];
    let fail = false;
    const deps = {
      listWorkspaceCwds: async () => [workspace],
      // The pull request has moved on since the review screen was drawn.
      resolvePullRequest: async () => ({ base: "c".repeat(40), head: MOVED, commits: [] }) as never,
      // Records argv only: no process, no network, no GitHub effect.
      runGh: async (args: string[]) => {
        calls.push(args);
        if (fail) throw new Error("rejected");
        return { stdout: "{}" };
      },
      paseoHome,
    };
    const msg = (patch: Partial<CheckoutPullRequestReviewDecideRequest> = {}) => ({
      type: "checkout.pull-request-review.decide.request" as const,
      requestId: "r1",
      cwd: workspace,
      pullRequest: 42,
      headOid: REVIEWED,
      decision: "approve" as const,
      note: '  ok; $(touch /tmp/x) `id` "q"  ',
      postToGithub: true,
      ...patch,
    });

    const result = await handlePullRequestReviewDecide({ msg: msg(), deps });
    expect(result).toMatchObject({
      status: "ok",
      decision: { headOid: REVIEWED, postedToGithub: true },
    });
    expect(calls).toEqual([
      [
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/pulls/42/reviews",
        "-f",
        `commit_id=${REVIEWED}`,
        "-f",
        "event=APPROVE",
        "-f",
        'body=ok; $(touch /tmp/x) `id` "q"',
      ],
    ]);
    // Zero approval of the new head: it appears nowhere, and the unpinned `gh pr review` is never used.
    expect(calls.flat().some((arg) => arg.includes(MOVED))).toBe(false);
    expect(calls.flat()).not.toContain("review");
    expect(
      await latestDecision({ paseoHome, key: path.resolve(workspace), pullRequest: 42 }),
    ).toMatchObject({ headOid: REVIEWED, decision: "approve", postedToGithub: true });

    // Fences: nothing is posted for an unserved folder, a missing head, or a decision not asked to be posted.
    calls.length = 0;
    for (const patch of [
      { cwd: path.join(workspace, "elsewhere") },
      { headOid: "HEAD" },
      { headOid: MOVED.slice(0, 7) },
      { postToGithub: false },
    ])
      await handlePullRequestReviewDecide({ msg: msg(patch), deps });
    expect(calls).toEqual([]);

    // One attempt, no retry: a refusal is reported and the decision is still recorded for the reviewed commit.
    fail = true;
    const refused = await handlePullRequestReviewDecide({
      msg: msg({ decision: "request_changes", note: "" }),
      deps,
    });
    expect(calls).toEqual([
      [
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/pulls/42/reviews",
        "-f",
        `commit_id=${REVIEWED}`,
        "-f",
        "event=REQUEST_CHANGES",
      ],
    ]);
    expect(refused).toMatchObject({
      status: "ok",
      decision: { headOid: REVIEWED, postedToGithub: false, postError: expect.any(String) },
    });
  });
});

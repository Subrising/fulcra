import path from "node:path";
import type {
  CheckoutPullRequestReviewDecideRequest,
  CheckoutPullRequestReviewDecideResponse,
  CheckoutPullRequestReviewFileDiffRequest,
  CheckoutPullRequestReviewFileDiffResponse,
  CheckoutPullRequestReviewGetRequest,
  CheckoutPullRequestReviewGetResponse,
} from "@getpaseo/protocol/messages";
import { getForgeRemoteUrl, getRangeFileDiff } from "../../utils/checkout-git.js";
import { assertRepoPath } from "../../utils/git-file-at-commit.js";
import { expandTilde } from "../../utils/path.js";
import type { PullRequestCommits } from "./architecture-change-request.js";
import {
  latestDecision,
  readAdwReview,
  recordDecision,
  reviewFiles,
  type ReviewDecision,
} from "./pull-request-review.js";

// `checkout.pull-request-review.*` (CONTRACTS v1.19): the PR review screen. `get` and `file-diff` only read;
// `decide` records the operator's decision on this host and posts a review pinned to the reviewed head commit only
// when `postToGithub` is true.

type GetPayload = CheckoutPullRequestReviewGetResponse["payload"];
type DiffPayload = CheckoutPullRequestReviewFileDiffResponse["payload"];
type DecidePayload = CheckoutPullRequestReviewDecideResponse["payload"];

const SHA40 = /^[0-9a-f]{40}$/;

const GITHUB_REVIEW_EVENT: Record<ReviewDecision["decision"], string> = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
};

export interface PullRequestReviewDeps {
  listWorkspaceCwds: () => Promise<string[]>;
  resolvePullRequest: (input: { cwd: string; number: number }) => Promise<PullRequestCommits>;
  runGh: (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
  paseoHome: string;
  adwHome?: string;
}

async function servedCwd(cwd: string, deps: PullRequestReviewDeps): Promise<string | null> {
  const requested = cwd.trim();
  if (!requested) return null;
  const resolved = path.resolve(expandTilde(requested));
  const served = (await deps.listWorkspaceCwds()).some(
    (known) => path.resolve(expandTilde(known)) === resolved,
  );
  return served ? resolved : null;
}

const NOT_SERVED = "This folder is not a workspace this host serves";

interface ForgeFacts {
  author?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision: string | null;
  checks: NonNullable<GetPayload["checks"]>;
}

function checksStatus(items: readonly { status: string }[]): ForgeFacts["checks"]["status"] {
  if (items.length === 0) return "none";
  if (items.some((i) => /fail|error|cancel|timed_out/i.test(i.status))) return "failure";
  if (items.some((i) => /pending|queued|in_progress|expected|waiting/i.test(i.status)))
    return "pending";
  return "success";
}

/** Author, state, review decision and checks from the forge (`gh pr view`); empty when unreadable. */
async function forgeFacts(
  cwd: string,
  number: number,
  deps: PullRequestReviewDeps,
): Promise<ForgeFacts> {
  try {
    const { stdout } = await deps.runGh(
      [
        "pr",
        "view",
        String(number),
        "--json",
        "author,state,isDraft,reviewDecision,statusCheckRollup",
      ],
      { cwd },
    );
    const raw = JSON.parse(stdout) as {
      author?: { login?: string };
      state?: string;
      isDraft?: boolean;
      reviewDecision?: string;
      statusCheckRollup?: {
        name?: string;
        context?: string;
        conclusion?: string;
        status?: string;
        state?: string;
      }[];
    };
    const items = (raw.statusCheckRollup ?? []).slice(0, 50).map((c) => ({
      name: (c.name ?? c.context ?? "check").slice(0, 120),
      status: (c.conclusion || c.state || c.status || "pending").toLowerCase(),
    }));
    return {
      author: raw.author?.login,
      state: raw.state,
      isDraft: raw.isDraft,
      reviewDecision: raw.reviewDecision ? raw.reviewDecision.toLowerCase() : null,
      checks: { status: checksStatus(items), items },
    };
  } catch {
    return { reviewDecision: null, checks: { status: "none", items: [] } };
  }
}

export async function handlePullRequestReviewGet(input: {
  msg: CheckoutPullRequestReviewGetRequest;
  deps: PullRequestReviewDeps;
}): Promise<GetPayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd) return { ...base, status: "error", error: NOT_SERVED };
  let pr: PullRequestCommits;
  try {
    pr = await deps.resolvePullRequest({ cwd, number: msg.pullRequest });
  } catch {
    return {
      ...base,
      status: "unavailable",
      error: "The pull request could not be read from the forge",
    };
  }
  const facts = await forgeFacts(cwd, pr.number, deps);
  const pullRequest = {
    number: pr.number,
    title: pr.title,
    ...(pr.url ? { url: pr.url } : {}),
    ...(facts.author ? { author: facts.author } : {}),
    ...(facts.state ? { state: facts.state } : {}),
    ...(facts.isDraft !== undefined ? { isDraft: facts.isDraft } : {}),
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName ?? null,
  };
  const common = {
    ...base,
    pullRequest,
    checks: facts.checks,
    reviewDecision: facts.reviewDecision,
  };
  if (
    !pr.baseRefOid ||
    !pr.headRefOid ||
    !SHA40.test(pr.baseRefOid) ||
    !SHA40.test(pr.headRefOid)
  ) {
    return {
      ...common,
      status: "unavailable",
      error: "The forge gave no commits for this pull request",
    };
  }
  try {
    const drawn = await reviewFiles({
      cwd,
      base: pr.baseRefOid,
      head: pr.headRefOid,
      title: pr.title,
    });
    if (!drawn) {
      return {
        ...common,
        status: "missing-commits",
        error: "The pull request's commits are not in this repository yet",
      };
    }
    const [adw, decision] = await Promise.all([
      readAdwReview({
        remoteUrl: await getForgeRemoteUrl(cwd),
        headOid: drawn.head,
        adwHome: deps.adwHome,
      }),
      latestDecision({ paseoHome: deps.paseoHome, key: cwd, pullRequest: pr.number }),
    ]);
    return {
      ...common,
      status: "ok",
      base: drawn.base,
      head: drawn.head,
      files: drawn.files,
      adw,
      decision,
    };
  } catch {
    return { ...common, status: "error", error: "The review could not be prepared" };
  }
}

export async function handlePullRequestReviewFileDiff(input: {
  msg: CheckoutPullRequestReviewFileDiffRequest;
  deps: PullRequestReviewDeps;
}): Promise<DiffPayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd) return { ...base, status: "error", error: NOT_SERVED };
  if (!SHA40.test(msg.base) || !SHA40.test(msg.head)) {
    return { ...base, status: "error", error: "Commits must be 40-character commit ids" };
  }
  try {
    const file = await getRangeFileDiff({
      cwd,
      base: msg.base,
      head: msg.head,
      path: assertRepoPath(msg.path),
    });
    return { ...base, status: "ok", file };
  } catch {
    return { ...base, status: "error", error: "The file's changes could not be read" };
  }
}

export async function handlePullRequestReviewDecide(input: {
  msg: CheckoutPullRequestReviewDecideRequest;
  deps: PullRequestReviewDeps;
}): Promise<DecidePayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd) return { ...base, status: "error", error: NOT_SERVED };
  if (!SHA40.test(msg.headOid))
    return { ...base, status: "error", error: "The head commit is required" };
  const decision: ReviewDecision = {
    pullRequest: msg.pullRequest,
    headOid: msg.headOid,
    decision: msg.decision,
    note: msg.note.trim(),
    at: new Date().toISOString(),
    postedToGithub: false,
  };
  // Posting is opt-in and separate; the decision is recorded here either way.
  if (msg.postToGithub) {
    try {
      // Pinned to the reviewed commit: `gh pr review` reviews whatever the head is at post time, so a push after
      // the person looked would be approved unseen. The REST review takes the exact `commit_id`; argv, no shell.
      await deps.runGh(
        [
          "api",
          "--method",
          "POST",
          `repos/{owner}/{repo}/pulls/${msg.pullRequest}/reviews`,
          "-f",
          `commit_id=${msg.headOid}`,
          "-f",
          `event=${GITHUB_REVIEW_EVENT[msg.decision]}`,
          ...(decision.note ? ["-f", `body=${decision.note}`] : []),
        ],
        { cwd },
      );
      decision.postedToGithub = true;
    } catch {
      decision.postError = "GitHub did not accept the review";
    }
  }
  try {
    await recordDecision({ paseoHome: deps.paseoHome, key: cwd, decision });
  } catch {
    return { ...base, status: "error", error: "The decision could not be recorded" };
  }
  return { ...base, status: "ok", decision };
}

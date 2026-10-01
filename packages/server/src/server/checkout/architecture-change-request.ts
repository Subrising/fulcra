import path from "node:path";
import type {
  CheckoutArchitectureChangeFetchRequest,
  CheckoutArchitectureChangeFetchResponse,
  CheckoutArchitectureChangeGetRequest,
  CheckoutArchitectureChangeGetResponse,
  CheckoutArchitectureGraphGetRequest,
  CheckoutArchitectureGraphGetResponse,
} from "@getpaseo/protocol/messages";
import {
  defaultBranchHead,
  graphAtCommit,
  graphForChange,
} from "../../utils/architecture-map/dependency-graph.js";
import { getArchitectureChange } from "../../utils/architecture-map/architecture-change-service.js";
import { expandTilde } from "../../utils/path.js";
import { runGitCommand } from "../../utils/run-git-command.js";

// `checkout.architecture-change.get` and `.fetch` (CONTRACTS v1.17). The cwd must be the directory of a
// workspace this daemon serves. `get` reads git objects only; `fetch` is the one network step, taken only when the
// person asks for it, and writes nothing but refs/fulcra/pull/<n>/{head,base}.

type GetPayload = CheckoutArchitectureChangeGetResponse["payload"];
type FetchPayload = CheckoutArchitectureChangeFetchResponse["payload"];

const SHA40 = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export interface PullRequestCommits {
  number: number;
  title: string;
  url?: string;
  baseRefName: string | null;
  headRefName?: string | null;
  baseRefOid: string | null;
  headRefOid: string | null;
}

export interface ArchitectureChangeDeps {
  listWorkspaceCwds: () => Promise<string[]>;
  resolvePullRequest: (input: { cwd: string; number: number }) => Promise<PullRequestCommits>;
}

async function servedCwd(cwd: string, deps: ArchitectureChangeDeps): Promise<string | null> {
  const requested = cwd.trim();
  if (!requested) return null;
  const resolved = path.resolve(expandTilde(requested));
  const served = (await deps.listWorkspaceCwds()).some(
    (known) => path.resolve(expandTilde(known)) === resolved,
  );
  return served ? resolved : null;
}

function repositoryTitle(cwd: string): string {
  return `${path.basename(cwd)} architecture`;
}

export async function handleArchitectureChangeGetRequest(input: {
  msg: CheckoutArchitectureChangeGetRequest;
  deps: ArchitectureChangeDeps;
}): Promise<GetPayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const failed = (status: "unavailable" | "error", error: string): GetPayload => ({
    ...base,
    status,
    error,
  });
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd) return failed("error", "This folder is not a workspace this host serves");
  if ((msg.pullRequest === undefined) === (msg.commits === undefined)) {
    return failed("error", "Choose one pull request or two commits");
  }
  let commits: { base: string; head: string };
  let pullRequest: GetPayload["pullRequest"];
  if (msg.pullRequest !== undefined) {
    let pr: PullRequestCommits;
    try {
      pr = await deps.resolvePullRequest({ cwd, number: msg.pullRequest });
    } catch {
      return failed("unavailable", "The pull request could not be read from the forge");
    }
    pullRequest = { number: pr.number, title: pr.title, ...(pr.url ? { url: pr.url } : {}) };
    if (!pr.baseRefOid || !pr.headRefOid) {
      return {
        ...failed("unavailable", "The forge gave no commits for this pull request"),
        pullRequest,
      };
    }
    commits = { base: pr.baseRefOid, head: pr.headRefOid };
  } else {
    commits = msg.commits ?? { base: "", head: "" };
  }
  if (!SHA40.test(commits.base) || !SHA40.test(commits.head)) {
    return { ...failed("error", "Commits must be 40-character commit ids"), pullRequest };
  }
  try {
    const result = await getArchitectureChange({
      cwd,
      base: commits.base,
      head: commits.head,
      title: pullRequest ? `#${pullRequest.number} ${pullRequest.title}` : repositoryTitle(cwd),
    });
    if (result.kind === "missing-commits") {
      return {
        ...base,
        status: "missing-commits",
        error: "The change's commits are not in this repository yet",
        pullRequest,
        base: commits.base,
        head: commits.head,
      };
    }
    if (result.kind === "no-merge-base") {
      return { ...failed("unavailable", "These commits have no common ancestor"), pullRequest };
    }
    const { change } = result;
    return {
      ...base,
      status: "ok",
      pullRequest,
      base: change.base,
      head: change.head,
      rules: change.rules,
      generatedAt: change.generatedAt,
      before: change.before,
      after: change.after,
      impact: change.impact,
    };
  } catch {
    return { ...failed("error", "The architecture could not be generated"), pullRequest };
  }
}

/** The remote the forge answers for: `origin` when there is one, else the only remote. */
async function forgeRemote(cwd: string): Promise<string | null> {
  const result = await runGitCommand(["remote"], { cwd, acceptExitCodes: [0, 128] });
  const remotes = result.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

export async function handleArchitectureChangeFetchRequest(input: {
  msg: CheckoutArchitectureChangeFetchRequest;
  deps: ArchitectureChangeDeps;
}): Promise<FetchPayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd)
    return { ...base, status: "error", error: "This folder is not a workspace this host serves" };
  let pr: PullRequestCommits;
  try {
    pr = await deps.resolvePullRequest({ cwd, number: msg.pullRequest });
  } catch {
    return { ...base, status: "error", error: "The pull request could not be read from the forge" };
  }
  const remote = await forgeRemote(cwd);
  if (!remote)
    return { ...base, status: "error", error: "This repository has no remote to fetch from" };
  const n = String(pr.number);
  const refspecs = [`+refs/pull/${n}/head:refs/fulcra/pull/${n}/head`];
  if (pr.baseRefName && BRANCH.test(pr.baseRefName) && !pr.baseRefName.includes("..")) {
    refspecs.push(`+refs/heads/${pr.baseRefName}:refs/fulcra/pull/${n}/base`);
  }
  const result = await runGitCommand(
    ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", remote, ...refspecs],
    {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      timeout: 120_000,
      acceptExitCodes: [0, 1, 128],
    },
  );
  if (result.exitCode !== 0) {
    return { ...base, status: "error", error: "The pull request's commits could not be fetched" };
  }
  return { ...base, status: "ok" };
}

type GraphPayload = CheckoutArchitectureGraphGetResponse["payload"];

/** `checkout.architecture-graph.get` (CONTRACTS v1.18): the whole repository as a module graph. */
export async function handleArchitectureGraphGetRequest(input: {
  msg: CheckoutArchitectureGraphGetRequest;
  deps: ArchitectureChangeDeps;
}): Promise<GraphPayload> {
  const { msg, deps } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd };
  const cwd = await servedCwd(msg.cwd, deps);
  if (!cwd)
    return { ...base, status: "error", error: "This folder is not a workspace this host serves" };
  try {
    if (msg.pullRequest === undefined) {
      const head = await defaultBranchHead(cwd);
      if (!head) return { ...base, status: "unavailable", error: "This repository has no commits" };
      return { ...base, status: "ok", ref: head.ref, graph: await graphAtCommit(cwd, head.commit) };
    }
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
    const pullRequest = { number: pr.number, title: pr.title, ...(pr.url ? { url: pr.url } : {}) };
    if (
      !pr.baseRefOid ||
      !pr.headRefOid ||
      !SHA40.test(pr.baseRefOid) ||
      !SHA40.test(pr.headRefOid)
    ) {
      return {
        ...base,
        status: "unavailable",
        error: "The forge gave no commits for this pull request",
        pullRequest,
      };
    }
    const result = await graphForChange({ cwd, base: pr.baseRefOid, head: pr.headRefOid });
    if (result.kind === "missing-commits") {
      return {
        ...base,
        status: "missing-commits",
        error: "The pull request's commits are not in this repository yet",
        pullRequest,
      };
    }
    if (result.kind === "no-merge-base") {
      return {
        ...base,
        status: "unavailable",
        error: "These commits have no common ancestor",
        pullRequest,
      };
    }
    return { ...base, status: "ok", ref: `#${pr.number}`, pullRequest, graph: result.graph };
  } catch {
    return { ...base, status: "error", error: "The dependency map could not be drawn" };
  }
}

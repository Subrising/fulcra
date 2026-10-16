import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repository = "Subrising/fulcra";
const shaPattern = /^[a-f0-9]{40}$/;

// API-only proof. The trusted handler never imports code from the PR.
function validateMerge(merge, head, sha) {
  if (
    merge.parents.length !== 2 ||
    merge.parents[1].sha !== sha ||
    merge.commit.tree.sha !== head.commit.tree.sha ||
    merge.commit.author.name !== "github-actions[bot]" ||
    merge.commit.author.email !== "41898282+github-actions[bot]@users.noreply.github.com" ||
    merge.commit.committer.name !== "GitHub" ||
    merge.commit.committer.email !== "noreply@github.com"
  )
    throw new Error("Merge tree or identity differs");
}

async function testedCI(sha, api) {
  const checks = await api(
    `/commits/${sha}/check-runs?check_name=ci-passed&filter=latest&per_page=100`,
  );
  const gates = checks.check_runs.filter(
    (check) => check.name === "ci-passed" && check.app.id === 15368,
  );
  if (
    gates.length !== 1 ||
    gates[0].head_sha !== sha ||
    gates[0].status !== "completed" ||
    gates[0].conclusion !== "success"
  )
    throw new Error("PR gate did not pass");
  const source =
    /^https:\/\/github\.com\/Subrising\/fulcra\/actions\/runs\/([0-9]+)\/job\/[0-9]+$/.exec(
      gates[0].details_url,
    );
  if (!source) throw new Error("Missing CI workflow provenance");
  const ci = await api(`/actions/runs/${source[1]}`);
  if (
    ci.path !== ".github/workflows/ci.yml" ||
    ci.event !== "pull_request" ||
    ci.head_sha !== sha ||
    ci.conclusion !== "success" ||
    ci.repository.full_name !== repository
  ) {
    throw new Error("Wrong CI workflow");
  }
  return ci;
}

export async function proveMerge(run, api) {
  if (
    run.path !== ".github/workflows/merge-pr.yml" ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.conclusion !== "success" ||
    run.repository.full_name !== repository
  ) {
    throw new Error("Untrusted merge workflow result");
  }
  const match = /^Merge PR ([1-9][0-9]*) at ([a-f0-9]{40})$/.exec(run.display_title);
  if (!match) throw new Error("Missing merge operation identity");
  const [, number, sha] = match;
  const pr = await api(`/pulls/${number}`);
  if (
    !pr.merged ||
    pr.base.ref !== "main" ||
    pr.head.sha !== sha ||
    pr.base.repo.full_name !== repository ||
    pr.head.repo.full_name !== repository ||
    !shaPattern.test(pr.merge_commit_sha)
  )
    throw new Error("Merged PR differs");
  const merge = await api(`/commits/${pr.merge_commit_sha}`);
  const head = await api(`/commits/${sha}`);
  validateMerge(merge, head, sha);
  const ci = await testedCI(sha, api);
  return {
    number: Number(number),
    sha,
    merged: pr.merge_commit_sha,
    tree: head.commit.tree.sha,
    ci: ci.html_url,
  };
}

export async function complete(event, api, postNotice) {
  const run = event.workflow_run;
  if (event.repository.full_name !== repository || run.repository.full_name !== repository) {
    throw new Error("Wrong repository");
  }
  let proof;
  if (run.path === ".github/workflows/merge-pr.yml" && run.conclusion === "success") {
    proof = await proveMerge(run, api);
    // Reconcile retries through an external ID. Do not make duplicate gates.
    const externalId = `tested-tree:${proof.merged}`;
    const existing = await api(
      `/commits/${proof.merged}/check-runs?check_name=ci-passed&filter=latest&per_page=100`,
    );
    if (
      !existing.check_runs.some(
        (check) =>
          check.external_id === externalId &&
          check.app.id === 15368 &&
          check.conclusion === "success",
      )
    ) {
      await api("/check-runs", {
        name: "ci-passed",
        head_sha: proof.merged,
        status: "completed",
        conclusion: "success",
        external_id: externalId,
        details_url: proof.ci,
        output: {
          title: "Tested PR tree",
          summary: `PR #${proof.number} passed CI. Merge tree ${proof.tree} equals its tested head tree.`,
        },
      });
    }
  }
  if (![".github/workflows/ci.yml", ".github/workflows/merge-pr.yml"].includes(run.path)) {
    throw new Error("Wrong workflow");
  }
  const related =
    run.path === ".github/workflows/ci.yml"
      ? await api(`/commits/${run.head_sha}/pulls?per_page=100`)
      : [];
  await postNotice({
    eventId: `${repository}:${run.id}:${run.run_attempt}`,
    repository,
    runId: run.id,
    attempt: run.run_attempt,
    workflow: run.path,
    sha: proof?.sha ?? run.head_sha,
    conclusion: run.conclusion,
    url: run.html_url,
    pullRequests: proof ? [proof.number] : related.map((pr) => pr.number),
    ...(proof ? { mergeSha: proof.merged, tree: proof.tree } : {}),
  });
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const api = async (path, body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub API failed: ${response.status}`);
    return response.json();
  };
  await complete(event, api, async (notice) => {
    const url = process.env.FULCRA_CI_NOTICE_URL;
    const token = process.env.FULCRA_CI_NOTICE_TOKEN;
    console.log(JSON.stringify(notice));
    if (!url || !token)
      throw new Error("Configure the authenticated Fulcra CI completion receiver");
    if (new URL(url).protocol !== "https:")
      throw new Error("The completion receiver requires HTTPS");
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(notice),
    });
    if (!response.ok) throw new Error(`Completion delivery failed: ${response.status}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

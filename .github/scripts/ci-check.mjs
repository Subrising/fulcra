const repository = "Subrising/fulcra";

// Shared by the trusted merge workflow and its tested-tree proof handler.
export async function selectPassedCI(checks, sha, api) {
  if (
    !Array.isArray(checks.check_runs) ||
    !Number.isSafeInteger(checks.total_count) ||
    checks.total_count < 0 ||
    checks.total_count !== checks.check_runs.length
  )
    throw new Error("Incomplete CI check results");
  const gates = checks.check_runs.filter((check) => {
    if (check.name !== "ci-passed") return false;
    if (!check.app) throw new Error("Missing CI check app identity");
    return check.app.id === 15368;
  });
  const ids = new Set();
  for (const gate of gates) {
    if (
      gate.head_sha !== sha ||
      !Number.isSafeInteger(gate.id) ||
      gate.id <= 0 ||
      ids.has(gate.id) ||
      gate.status !== "completed" ||
      !["success", "cancelled"].includes(gate.conclusion)
    )
      throw new Error("PR gate did not pass");
    ids.add(gate.id);
  }
  // With ci-passed's !cancelled() condition, a cancelled gate can hide failed needs-jobs.
  // Earlier successful PR CI proves this SHA/tree when the merge guard confirms main is an ancestor.
  // This does not prove that every later cancelled run's dependency jobs passed.
  const passed = gates.filter((gate) => gate.conclusion === "success").sort((a, b) => b.id - a.id);
  if (!passed.length) throw new Error("PR gate did not pass");
  let selected;
  for (const gate of passed) {
    const run = await readPassedPRRun(gate, sha, api);
    selected ??= { gate, run };
  }
  return selected;
}

async function readPassedPRRun(gate, sha, api) {
  const source =
    /^https:\/\/github\.com\/Subrising\/fulcra\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/.exec(
      gate.details_url,
    );
  if (!source) throw new Error("Missing CI workflow provenance");
  const run = await api(`/actions/runs/${source[1]}`);
  if (
    run?.path !== ".github/workflows/ci.yml" ||
    run.event !== "pull_request" ||
    run.head_sha !== sha ||
    !Number.isSafeInteger(run.id) ||
    run.id !== Number(source[1]) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== repository
  )
    throw new Error("Wrong CI workflow");
  return run;
}

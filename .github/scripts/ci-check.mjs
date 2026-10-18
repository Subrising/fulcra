// Shared by the trusted merge workflow and its tested-tree proof handler.
export function selectPassedCI(checks, sha) {
  const gates = checks.check_runs.filter(
    (check) => check.name === "ci-passed" && check.app.id === 15368,
  );
  if (checks.total_count > checks.check_runs.length) throw new Error("Incomplete CI check results");
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
  const passed = gates
    .filter((gate) => gate.conclusion === "success")
    .sort((a, b) => b.id - a.id)[0];
  if (!passed) throw new Error("PR gate did not pass");
  return passed;
}

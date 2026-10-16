export const BROWSER_SHARDS = 24;

export function balanceTests(tests, seconds, count = BROWSER_SHARDS) {
  const buckets = Array.from({ length: count }, () => ({ seconds: 0, tests: [] }));
  const weighted = tests.map((test) => ({ ...test, seconds: seconds[test.key] ?? 12 }));
  weighted.sort((a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
  for (const test of weighted) {
    const target = buckets.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    target.tests.push(test);
    target.seconds += test.seconds;
  }
  if (
    new Set(buckets.flatMap((bucket) => bucket.tests.map((test) => test.key))).size !== tests.length
  ) {
    throw new Error("Browser plan contains duplicate test identities");
  }
  return buckets;
}

export function testListPath(shard, attempt, { exists, read }) {
  const retry = attempt > 1;
  let list = `.e2e-plan/shard-${shard}.txt`;
  if (shard === "recovery") list = ".e2e-plan/recovery.txt";
  if (retry) list = ".e2e-retry/failed.txt";
  if (retry && exists("packages/app/.e2e-retry/incomplete"))
    throw new Error("Previous run was incomplete; refusing a whole-shard retry.");
  if (!exists(`packages/app/${list}`))
    throw new Error("Missing exact test list. Refusing to rerun a whole shard.");
  if (!read(`packages/app/${list}`).trim()) {
    if (retry) return null;
    throw new Error("Empty browser shard");
  }
  return list;
}

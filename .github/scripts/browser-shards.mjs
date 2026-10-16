export const BROWSER_SHARDS = 24;

export function balanceTests(tests, seconds, count = BROWSER_SHARDS) {
  const buckets = Array.from({ length: count }, () => ({ seconds: 0, tests: [] }));
  const weighted = tests.map((test) => ({ ...test, seconds: seconds[test.key] ?? 12 }));
  const files = new Map();
  for (const item of weighted) {
    const file = item.file ?? item.key.split(" › ")[0];
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(item);
  }
  const chunks = [];
  const chunk = (file, cases) => ({
    file,
    tests: cases,
    seconds: cases.reduce((sum, test) => sum + test.seconds, 0),
  });
  // Keep ordinary file fixtures together. Split a slow file into bounded groups.
  for (const [file, items] of files) {
    let current = [];
    let duration = 0;
    for (const item of items) {
      if (current.length && duration + item.seconds > 120) {
        chunks.push(chunk(file, current));
        current = [];
        duration = 0;
      }
      current.push(item);
      duration += item.seconds;
    }
    if (current.length) chunks.push(chunk(file, current));
  }
  // Small test selections must still fill every possible shard.
  while (chunks.length < Math.min(count, tests.length)) {
    const candidates = chunks.filter((item) => item.tests.length > 1);
    if (!candidates.length) break;
    const largest = candidates.reduce((a, b) => (a.seconds >= b.seconds ? a : b));
    const midpoint = Math.ceil(largest.tests.length / 2);
    chunks.splice(
      chunks.indexOf(largest),
      1,
      chunk(largest.file, largest.tests.slice(0, midpoint)),
      chunk(largest.file, largest.tests.slice(midpoint)),
    );
  }
  chunks.sort((a, b) => b.seconds - a.seconds || a.tests[0].key.localeCompare(b.tests[0].key));
  const assignedFiles = new Map(buckets.map((bucket) => [bucket, new Set()]));
  for (const group of chunks) {
    const candidates = buckets.filter((bucket) => !assignedFiles.get(bucket).has(group.file));
    const target = (candidates.length ? candidates : buckets).reduce((a, b) =>
      a.seconds <= b.seconds ? a : b,
    );
    target.tests.push(...group.tests);
    target.seconds += group.seconds;
    assignedFiles.get(target).add(group.file);
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

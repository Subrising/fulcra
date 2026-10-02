// Runs each security mutation in an isolated temporary copy; never changes the checkout.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
const original = await fs.readFile(new URL("./worktree-lifecycle.mjs", import.meta.url), "utf8");
const cases = [
  [
    "fully-pushed",
    "if (unpushed > 0) blockers.push",
    "if (false) blockers.push",
    "unpushed remains intact",
  ],
  [
    "root-containment",
    "if (!inside(root, canonical)) throw Error('Path escapes the tasks root');",
    "if (false) throw Error('Path escapes the tasks root');",
    "escaped symlink and direct root containment are refused",
  ],
  [
    "unrecognised-ignored",
    "if (ignored.some(p => !p.split('/').some(x => outputNames.has(x)) && !preserveEvidence(p)))",
    "if (false)",
    "unrecognised ignored files block",
  ],
  [
    "detached-head",
    "if (!branch) blockers.push",
    "if (false) blockers.push",
    "detached HEAD with unpushed",
  ],
  [
    "nested-repository",
    "if (roots.some(other => other !== wt && inside(wt, other)))",
    "if (false)",
    "nested ignored repository",
  ],
  [
    "internal-alias",
    "if (canonical !== path.resolve(target) &&",
    "if (false &&",
    "internal symlink alias is refused",
  ],
  [
    "loose-signing",
    "if (files.some(f => f.category !== 'kept' &&",
    "if (files.some(f => false &&",
    "loose dist signing key",
  ],
  [
    "hidden-index",
    "if (flags.some(l => /^[a-zS] /.test(l)))",
    "if (false)",
    "hidden tracked edits",
  ],
  [
    "automatic-default",
    "if (e.code === 'ENOENT') return 'never'",
    "if (e.code === 'ENOENT') return 7",
    "automatic cleanup defaults off",
  ],
];
for (const [name, from, to, expected] of cases) {
  if (!original.includes(from)) throw Error(`Mutation anchor missing: ${name}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wl-mutation-"));
  try {
    for (const file of ["schema.mjs", "worktree-lifecycle.test.mjs"])
      await fs.copyFile(new URL(file, import.meta.url), path.join(dir, file));
    await fs.writeFile(path.join(dir, "worktree-lifecycle.mjs"), original.replace(from, to));
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", path.join(dir, "worktree-lifecycle.test.mjs")],
      { encoding: "utf8", timeout: 180000 },
    );
    if (run.status === 0 || run.error)
      throw Error(`Mutation not killed: ${name}: ${run.error ?? "tests passed"}`);
    if (
      !run.stdout
        .split("\n")
        .some((line) => line.startsWith("not ok") && line.includes(expected)) ||
      !run.stdout.includes("ERR_ASSERTION")
    )
      throw Error(`Expected safety assertion did not fail: ${name}`);
    console.log(`${name}: KILLED`);
    console.log(
      run.stdout
        .split("\n")
        .filter((line) => /not ok|# fail|# pass/.test(line))
        .join("\n"),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

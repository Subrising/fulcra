import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { recordTestFixtureOwner, testFixtureInUse } from "./test-fixture-ownership.js";

test("keeps unknown fixtures and live soak owners; admits only an exact retired owner lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixture-owner-test-"));
  try {
    expect(await testFixtureInUse(directory, 123, "unknown", async () => [])).toBe(true);
    await recordTestFixtureOwner(directory, process.pid);
    const [name] = await readdir(join(directory, ".fulcra-fixture-owners"));
    const file = join(directory, ".fulcra-fixture-owners", name!);
    const lease = JSON.parse(await readFile(file, "utf8"));
    const live = { ...lease.owner, ppid: 1, groupId: 1, detached: false, zombie: false };
    expect(
      await testFixtureInUse(directory, lease.target.pid, lease.target.birth, async () => [live]),
    ).toBe(true);
    expect(
      await testFixtureInUse(directory, lease.target.pid, lease.target.birth, async () => []),
    ).toBe(false);
    expect(await testFixtureInUse(directory, lease.target.pid, "reused", async () => [])).toBe(
      true,
    );
    await writeFile(file, "invalid lease");
    expect(
      await testFixtureInUse(directory, lease.target.pid, lease.target.birth, async () => []),
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

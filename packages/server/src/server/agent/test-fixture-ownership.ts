import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readOwnedProcessTable, type OwnedProcessIdentity } from "../../utils/tree-kill.js";

const identity = z.object({pid: z.number().int().positive(), birth: z.string().min(1)});
const lease = z.object({version: z.literal(1), owner: identity, target: identity});
function leaseFile(cwd: string, target: {pid: number; birth: string}): string {
  return join(cwd, ".fulcra-fixture-owners", `${target.pid}-${createHash("sha256").update(target.birth).digest("hex")}.json`);
}
/** Test harnesses publish exact helper and test-worker identities, never arguments. */
export async function recordTestFixtureOwner(cwd: string, pid: number): Promise<void> {
  const rows = await readOwnedProcessTable();
  const owner = rows.find((row) => row.pid === process.pid && !row.zombie);
  const target = rows.find((row) => row.pid === pid && !row.zombie);
  if (!owner || !target) return;
  const file = leaseFile(cwd, target);
  await fs.mkdir(join(cwd, ".fulcra-fixture-owners"), {recursive: true, mode: 0o700});
  await fs.writeFile(file, JSON.stringify({version: 1, owner: {pid: owner.pid, birth: owner.birth}, target: {pid, birth: target.birth}}), {mode: 0o600});
}
/** Missing or invalid ownership keeps the helper. A live soak-test worker also keeps it. */
export async function testFixtureInUse(cwd: string, pid: number, birth: string, read = readOwnedProcessTable): Promise<boolean> {
  try {
    const file = leaseFile(cwd, {pid, birth});
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return true;
    const record = lease.parse(JSON.parse(await fs.readFile(file, "utf8")));
    if (record.target.pid !== pid || record.target.birth !== birth) return true;
    const owner = (await read()).find((row: OwnedProcessIdentity) => row.pid === record.owner.pid);
    return Boolean(owner && !owner.zombie && owner.birth === record.owner.birth);
  } catch { return true; }
}

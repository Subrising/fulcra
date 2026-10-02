// Test-only portable configuration. Import it before any plugin module: some modules read the company, programme
// and artifact settings when they load. It gives this test process its own private state root, so no live or
// shared configuration is read, and names two example hosts: `mini` (this Mac) and `macbook` (a remote host).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { firstRun, type Config } from "../../src/config.mjs";

const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-portable-fixture-"));
process.env.ORCA_HOME = home;
delete process.env.PASEO_HOME;
firstRun();
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const file = path.join(home, "config.json");

export const FIXTURE_COMPANY = randomUUID(),
  FIXTURE_PROGRAMME = randomUUID();
export const FIXTURE_ISSUE_API = "http://127.0.0.1:3200";
export const FIXTURE_ARTIFACTS: Record<string, string[]> = {
  [randomUUID()]: ["claude/leadership-brief.md", "claude/review-checklist.md"],
  [randomUUID()]: ["codex/leadership-brief.md", "codex/peer-review.md"],
};
/** Replaces top-level settings of this process's fixture configuration. Settings read at load time keep their first value. */
export function setPortableFixture(patch: Partial<Config>) {
  const config = { ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
setPortableFixture({
  authority: {
    companyId: FIXTURE_COMPANY,
    programmeId: FIXTURE_PROGRAMME,
    issueApi: FIXTURE_ISSUE_API,
  },
  localHost: { name: "mini", serverId: null },
  hosts: [{ name: "macbook", serverId: null }],
  artifacts: FIXTURE_ARTIFACTS,
});

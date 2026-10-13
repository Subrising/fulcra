import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSnapshotPayloadSchema } from "@getpaseo/protocol/messages";
import {
  checkBranch,
  checkIdentity,
  checkSessionArchive,
  checkWorktree,
  formatChecks,
  runCheckCommand,
  type CheckRunner,
} from "./checks.js";

function replies(outputs: Array<{ code?: number; stdout?: string; stderr?: string }>): CheckRunner {
  return async () => {
    const next = outputs.shift();
    if (!next) throw new Error("Unexpected command");
    return { code: next.code ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
}
const sha = "a".repeat(40);
const commit = `${sha}\tFulcra\tfulcra@users.noreply.github.com\tFulcra\tfulcra@users.noreply.github.com\n`;
const pr = {
  headRefOid: sha,
  url: "https://example.test/pr/1",
  state: "OPEN",
  statusCheckRollup: [
    { name: "tests", status: "COMPLETED", conclusion: "SUCCESS" },
    { context: "build", state: "SUCCESS" },
  ],
};
function branchReplies(pull = pr, remote = sha): CheckRunner {
  return replies([
    { stdout: "feature\n" },
    { stdout: sha },
    { stdout: `${remote}\trefs/heads/feature\n` },
    { stdout: "https://github.com/fixture/project.git" },
    { stdout: JSON.stringify(pull) },
  ]);
}
function session() {
  return AgentSnapshotPayloadSchema.parse({
    id: "fixture-session",
    provider: "codex",
    cwd: "/fixture",
    model: null,
    createdAt: "2026-10-13T00:00:00Z",
    updatedAt: "2026-10-13T00:00:00Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Fixture",
    archiveSafety: { inFlight: false, heldMessages: 0, heldReports: 0 },
  });
}
describe("lifecycle checks", () => {
  it("accepts both commit identities", async () => {
    expect(await checkIdentity(".", "base..HEAD", replies([{ stdout: commit }]))).toEqual([
      { check: "identity", pass: true, reason: "1 commits use the Fulcra author and committer" },
    ]);
  });
  it.each([2, 4])("rejects incorrect author or committer email %s", async (index) => {
    const fields = commit.trim().split("\t");
    fields[index] = "fixture@example.test";
    expect(
      (await checkIdentity(".", "HEAD", replies([{ stdout: fields.join("\t") }])))[0]?.pass,
    ).toBe(false);
  });
  it.each([1, 3])("rejects incorrect author or committer name %s", async (index) => {
    const fields = commit.trim().split("\t");
    fields[index] = "Fixture";
    expect(
      (await checkIdentity(".", "HEAD", replies([{ stdout: fields.join("\t") }])))[0]?.pass,
    ).toBe(false);
  });
  it("refuses empty ranges and Git errors", async () => {
    expect((await checkIdentity(".", "HEAD", replies([{}])))[0]?.pass).toBe(false);
    expect(
      await checkIdentity(".", "bad", replies([{ code: 128, stderr: "Unknown revision" }])),
    ).toEqual([{ check: "identity", pass: false, reason: "Unknown revision" }]);
  });
  it("rejects option injection", async () => {
    await expect(checkIdentity(".", "--all")).rejects.toThrow("Git reference");
  });
  it("checks the remote and PR head with CI", async () => {
    expect((await checkBranch(".", branchReplies())).map((r) => r.pass)).toEqual([
      true,
      true,
      true,
    ]);
  });
  it("reports mismatched remote and PR heads", async () => {
    expect(
      (
        await checkBranch(".", branchReplies({ ...pr, headRefOid: "b".repeat(40) }, "b".repeat(40)))
      ).map((r) => r.pass),
    ).toEqual([false, false, true]);
  });
  it.each(["FAILURE", "PENDING", "CANCELLED", "TIMED_OUT"])(
    "reports failed or unfinished CI %s",
    async (state) => {
      const output = await checkBranch(
        ".",
        branchReplies({
          ...pr,
          statusCheckRollup: [{ name: "tests", status: "COMPLETED", conclusion: state }],
        }),
      );
      expect(output[2]?.pass).toBe(false);
      expect(output[2]?.reason).toContain(state);
    },
  );
  it("fails when CI is missing", async () => {
    expect((await checkBranch(".", branchReplies({ ...pr, statusCheckRollup: [] })))[2]?.pass).toBe(
      false,
    );
  });
  it("reports detached HEAD and failed PR lookup", async () => {
    expect(
      (await checkBranch(".", replies([{ code: 1, stderr: "Detached HEAD" }])))[0]?.reason,
    ).toBe("Detached HEAD");
    expect(
      (
        await checkBranch(
          ".",
          replies([
            { stdout: "feature" },
            { stdout: sha },
            { stdout: sha },
            { stdout: "https://github.com/fixture/project.git" },
            { code: 1, stderr: "No PR" },
          ]),
        )
      )[1]?.reason,
    ).toBe("No PR");
  });
  it("fails malformed PR output", async () => {
    expect(
      (
        await checkBranch(
          ".",
          replies([
            { stdout: "feature" },
            { stdout: sha },
            { stdout: sha },
            { stdout: "https://github.com/fixture/project.git" },
            { stdout: "not JSON" },
          ]),
        )
      )[1]?.pass,
    ).toBe(false);
  });
  it("passes a clean merged linked worktree", async () => {
    expect(
      (
        await checkWorktree(
          ".",
          "origin/main",
          replies([
            { stdout: "worktree /fixture/main\n\nworktree /fixture/job\n" },
            { stdout: "/fixture/job\n" },
            {},
            { stdout: sha },
            { stdout: sha },
            {},
          ]),
        )
      ).map((r) => r.pass),
    ).toEqual([true, true, true]);
  });
  it("refuses the main checkout, unsaved files, and unmerged commits", async () => {
    expect(
      (
        await checkWorktree(
          ".",
          "origin/main",
          replies([
            { stdout: "worktree /fixture/main\n" },
            { stdout: "/fixture/main\n" },
            { stdout: "?? unsaved.txt\n!! ignored.txt\n" },
            { stdout: sha },
            { stdout: sha },
            { code: 1 },
          ]),
        )
      ).map((r) => r.pass),
    ).toEqual([false, false, false]);
  });
  it("fails an unknown merge target", async () => {
    expect(
      (
        await checkWorktree(
          ".",
          "unknown",
          replies([
            { stdout: "worktree /fixture/main\n" },
            { stdout: "/fixture/job" },
            {},
            { code: 128, stderr: "Unknown base" },
          ]),
        )
      )[2]?.reason,
    ).toBe("Unknown base");
  });
  it("passes an idle stopped session without held messages", () => {
    expect(checkSessionArchive(session()).map((r) => r.pass)).toEqual([true, true, true, true]);
  });
  it("fails active sessions and held queues", () => {
    const agent = session();
    agent.status = "running";
    agent.archiveSafety = { inFlight: true, heldMessages: 2, heldReports: 1 };
    expect(checkSessionArchive(agent).map((r) => r.pass)).toEqual([false, false, false, false]);
  });
  it("fails unknown queue state and old hosts", () => {
    const agent = session();
    agent.archiveSafety = { inFlight: false, heldMessages: null, heldReports: null };
    expect(checkSessionArchive(agent).map((r) => r.pass)).toEqual([true, true, false, false]);
    delete agent.archiveSafety;
    expect(checkSessionArchive(agent)[0]?.pass).toBe(false);
    expect(checkSessionArchive(null)[0]?.pass).toBe(false);
  });
  it("keeps each check on one line", () => {
    expect(formatChecks([{ check: "fixture", pass: false, reason: "first\nsecond" }])).toBe(
      "FAIL fixture: first second",
    );
  });
  it("runs read-only checks against real Git data", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fulcra-check-"));
    try {
      expect((await runCheckCommand("git", ["init", "--initial-branch=main"], cwd)).code).toBe(0);
      for (const [key, value] of [
        ["user.name", "Fulcra"],
        ["user.email", "fulcra@users.noreply.github.com"],
      ])
        expect((await runCheckCommand("git", ["config", key!, value!], cwd)).code).toBe(0);
      expect(
        (
          await runCheckCommand(
            "git",
            ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"],
            cwd,
          )
        ).code,
      ).toBe(0);
      expect((await checkIdentity(cwd, "HEAD"))[0]?.pass).toBe(true);
      const worktree = join(cwd, "job");
      expect(
        (await runCheckCommand("git", ["worktree", "add", "-b", "job", worktree], cwd)).code,
      ).toBe(0);
      expect((await checkWorktree(worktree, "main")).map((r) => r.pass)).toEqual([
        true,
        true,
        true,
      ]);
      await writeFile(join(worktree, "unsaved.txt"), "synthetic");
      expect((await checkWorktree(worktree, "main"))[1]?.pass).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

it("bounds identity failures and offers full evidence", async () => {
  const invalid = Array.from(
    { length: 20 },
    (_, i) =>
      `${i.toString(16).padStart(40, "0")}\tFixture\tfixture@example.test\tFixture\tfixture@example.test`,
  ).join("\n");
  const compact = await checkIdentity(".", "HEAD", replies([{ stdout: invalid }]));
  expect(compact[0]?.reason).toContain("15 more omitted; use --full-result");
  expect(formatChecks(compact).length).toBeLessThan(400);
  const full = await checkIdentity(".", "HEAD", replies([{ stdout: invalid }]), true);
  expect(full[0]?.reason).toContain("13".padStart(40, "0"));
  expect(full[0]?.reason).not.toContain("omitted");
});

it("uses the selected remote for both the branch and the PR repository", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const next = branchReplies();
  const run: CheckRunner = async (command, args, cwd) => {
    calls.push({ command, args });
    return next(command, args, cwd);
  };
  expect((await checkBranch(".", run, "fulcra")).map((row) => row.pass)).toEqual([
    true,
    true,
    true,
  ]);
  expect(calls[2]?.args).toEqual(["ls-remote", "--exit-code", "fulcra", "refs/heads/feature"]);
  expect(calls[4]?.args).toContain("github.com/fixture/project");
});

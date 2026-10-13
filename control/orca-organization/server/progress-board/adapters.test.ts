import { describe, expect, test } from "vitest";
import {
  AgentSnapshotPayloadSchema,
  ProjectPlacementPayloadSchema,
} from "@getpaseo/protocol/messages";
import { adaptJobs, lastResult, parseLedger } from "./adapters";
import { readBranch, type Run } from "./git";
const header =
  "| id | item | kind | owner | status | evidence | source |\n| --- | --- | --- | --- | --- | --- | --- |\n";
describe("ledger adapter", () => {
  test.each(["", "\n"])("reports an empty ledger: %j", (value) =>
    expect(parseLedger(value).notice).toContain("empty"),
  );
  test.each([
    "garbage",
    "| id | item |",
    header.replace("| --- | --- | --- | --- | --- | --- | --- |", "| --- |"),
  ])("reports malformed tables: %j", (value) =>
    expect(parseLedger(value).notice).toContain("malformed"),
  );
  test("parses every lane, CRLF, escaped pipes and excludes moved rows", () => {
    const value = parseLedger(
      header +
        [
          "| FU-1 | Choose A \\| B | DECIDE | Owner | OPEN | | Request |",
          "| FU-2 | Work | BUILD | Owner | IN PROGRESS | Evidence | Source |",
          "| FU-3 | Finish | FIX | Owner | DONE | Test | Source |",
          "| FU-4 | Next task | BUILD | Owner | NEXT | | Source |",
          "| FU-5 | Later | BUILD | Owner | OPEN | | Source |",
          "| FU-6 | Moved task | BUILD | Owner | MOVED to other | | Source |",
        ].join("\r\n"),
    );
    expect(value.items.map((row) => row.lane)).toEqual([
      "DECIDE",
      "In progress",
      "Done",
      "Next",
      "Open",
    ]);
    expect(value.items[0].item).toBe("Choose A | B");
    expect(value.notice).toBe("");
  });
  test("reports duplicate, malformed and unknown-status rows", () => {
    const value = parseLedger(
      header +
        "| FU-1 | Work | BUILD | | OPEN | | |\n| FU-1 | Duplicate | BUILD | | OPEN | | |\n| FU-2 | Bad | BUILD | | UNKNOWN | | |\n| Bad | Row |",
    );
    expect(value.items).toHaveLength(1);
    expect(value.notice).toContain("3 invalid");
  });
  test("accepts reordered headings and does not use prose as a job", () => {
    const value = parseLedger(
      "| status | id | item | kind | owner | evidence | source |\n| --- | --- | --- | --- | --- | --- | --- |\n| OPEN | FU-1 | Work | BUILD | Team | | Source |\n\nSome prose",
    );
    expect(value.items[0].id).toBe("FU-1");
  });
});
const agent = AgentSnapshotPayloadSchema.parse({
  id: "test-job",
  provider: "codex",
  cwd: "/synthetic/repo",
  model: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsImageInput: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Synthetic job",
  labels: {},
});
const project = ProjectPlacementPayloadSchema.parse({
  projectKey: "synthetic",
  projectName: "Sample Project",
  checkout: {
    cwd: "/synthetic/repo",
    isGit: false,
    currentBranch: null,
    remoteUrl: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  },
});
describe("job adapter", () => {
  test("supports an empty directory", () =>
    expect(adaptJobs([], "Test host", new Map())).toEqual([]));
  test("projects job state, machine, result and age basis", () => {
    expect(
      adaptJobs([{ agent, project }], "Test host", new Map([[agent.id, "Tests passed."]]))[0],
    ).toMatchObject({
      title: "Synthetic job",
      machine: "Test host",
      result: "Tests passed.",
      project: "sample-project",
      createdAt: agent.createdAt,
      waiting: false,
    });
  });
  test("excludes archives and shows missing results", () => {
    expect(
      adaptJobs([{ agent: { ...agent, archivedAt: "2026-01-02" }, project }], "Host", new Map()),
    ).toEqual([]);
    expect(adaptJobs([{ agent, project }], "Host", new Map())[0].result).toBe(
      "No result was recorded.",
    );
  });
  test("preserves permission state and prefers the project label", () => {
    const job = {
      ...agent,
      labels: { "fulcra.project": "Target Project" },
      pendingPermissions: [
        { id: "permission", provider: "codex", name: "Approval", kind: "tool" as const },
      ],
    };
    expect(adaptJobs([{ agent: job, project }], "Host", new Map())[0]).toMatchObject({
      waiting: true,
      project: "target-project",
    });
  });
  test("takes only the last assistant result", () => {
    expect(
      lastResult([
        { type: "assistant_message", text: "First" },
        { type: "user_message", text: "Ignored" },
        { type: "assistant_message", text: "\nLast result\nDetails" },
      ]),
    ).toBe("Last result");
    expect(lastResult([])).toBe("No result was recorded.");
  });
});
function commands(prs: string, ghCode = 0, mergedCode = 1): Run {
  return async (file, args) =>
    file === "gh"
      ? { code: ghCode, output: prs }
      : args[0] === "rev-parse"
        ? { code: 0, output: "abc123" }
        : args[0] === "merge-base"
          ? { code: mergedCode, output: "" }
          : { code: 0, output: args.includes("--short") ? "feature" : "refs/remotes/origin/main" };
}
describe("branch adapter", () => {
  test.each([
    ["SUCCESS", "Passed"],
    ["FAILURE", "Failed"],
    ["IN_PROGRESS", "Pending"],
    ["CANCELLED", "Failed"],
  ])("maps CI %s to %s", async (state, ci) => {
    const branch = await readBranch(
      "/synthetic",
      commands(
        JSON.stringify([
          { state: "OPEN", headRefOid: "abc123", statusCheckRollup: [{ conclusion: state }] },
        ]),
      ),
    );
    expect(branch).toMatchObject({ branch: "feature", head: "abc123", state: "Open PR", ci });
  });
  test("does not claim CI for a different head", async () => {
    expect(
      (await readBranch("/synthetic", commands('[{"state":"MERGED","headRefOid":"other"}]'))).ci,
    ).toBe("No PR for this head");
  });
  test("shows unavailable commands and invalid JSON", async () => {
    expect((await readBranch("/synthetic", commands("", -1, 0))).state).toBe("Merged locally");
    expect((await readBranch("/synthetic", commands("not JSON"))).ci).toBe("Invalid CI response");
    expect((await readBranch("/synthetic", async () => ({ code: -1, output: "" }))).state).toBe(
      "Unavailable",
    );
  });
});

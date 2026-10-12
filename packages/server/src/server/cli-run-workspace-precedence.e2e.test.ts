import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { runPaseoCli, type TestDaemonContext } from "../../../cli/tests/helpers/test-daemon.js";

// The daemon-level workspace contract that `paseo run` depends on: each
// local-backed createWorkspace for a cwd mints a fresh, distinct workspace,
// createAgent stamps the agent with the workspaceId it is given. CLI calls
// below verify reuse through the real workspace directory search and transport.

async function workspaceIds(client: DaemonClient): Promise<Set<string>> {
  const workspaces = await client.fetchWorkspaces();
  return new Set(workspaces.entries.map((entry) => entry.id));
}

async function mintLocalWorkspace(client: DaemonClient, cwd: string): Promise<string> {
  const result = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (!result.workspace) {
    throw new Error(result.error ?? "Failed to create workspace");
  }
  return result.workspace.id;
}

test("daemon resolves human and managed CLI workspace ownership", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-cwd-"));
  const otherCwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-other-cwd-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    // The daemon creates a local workspace and assigns its ID to the agent.
    const firstWorkspaceId = await mintLocalWorkspace(client, cwd);

    const firstAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: firstWorkspaceId,
      title: "First run agent",
    });
    expect(firstAgent.workspaceId).toBe(firstWorkspaceId);
    expect(await workspaceIds(client)).toContain(firstWorkspaceId);

    const fetchedFirst = await client.fetchAgent({ agentId: firstAgent.id });
    expect(fetchedFirst?.agent.workspaceId).toBe(firstWorkspaceId);

    // A different directory gets a distinct workspace.
    const secondWorkspaceId = await mintLocalWorkspace(client, otherCwd);
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);

    const secondAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
      workspaceId: secondWorkspaceId,
      title: "Second run agent",
    });
    expect(secondAgent.workspaceId).toBe(secondWorkspaceId);
    expect(secondAgent.workspaceId).not.toBe(firstAgent.workspaceId);

    const idsAfterTwoMints = await workspaceIds(client);
    expect(idsAfterTwoMints).toContain(firstWorkspaceId);
    expect(idsAfterTwoMints).toContain(secondWorkspaceId);

    // Attaching to an existing workspace by id (how --workspace and
    // $PASEO_WORKSPACE_ID land a run) creates no new workspace record: the
    // agent lands in the named workspace and the workspace set is unchanged.
    const idsBeforeAttach = await workspaceIds(client);
    const attachedAgent = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: path.join(otherCwd, "stale-client-directory"),
      workspaceId: firstWorkspaceId,
      title: "Attached agent",
    });
    expect(attachedAgent.workspaceId).toBe(firstWorkspaceId);
    expect(attachedAgent.cwd).toBe(cwd);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    await expect(
      client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd,
        workspaceId: "wks_missing",
        title: "Missing workspace agent",
      }),
    ).rejects.toThrow("Workspace wks_missing not found");

    const sameWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: otherCwd,
      callerAgentId: firstAgent.id,
      title: "Same workspace child",
    });
    expect(sameWorkspaceChild.workspaceId).toBe(firstWorkspaceId);
    expect(sameWorkspaceChild.cwd).toBe(firstAgent.cwd);
    expect(sameWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
    expect(await workspaceIds(client)).toEqual(idsBeforeAttach);

    const crossWorkspaceChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      workspaceId: secondWorkspaceId,
      callerAgentId: firstAgent.id,
      title: "Cross workspace child",
    });
    expect(crossWorkspaceChild.workspaceId).toBe(secondWorkspaceId);
    expect(crossWorkspaceChild.cwd).toBe(otherCwd);
    expect(crossWorkspaceChild.labels[PARENT_AGENT_ID_LABEL]).toBe(firstAgent.id);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  }
}, 180000);

test("CLI run retains structured agent IDs and reuses the directory workspace", async () => {
  const daemon = await createTestPaseoDaemon();
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-run-reuse-"));
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const context: TestDaemonContext = {
    port: daemon.port,
    wsUrl: `ws://127.0.0.1:${daemon.port}/ws`,
    paseoHome: daemon.paseoHome,
    workDir: cwd,
    process: null,
    isReady: true,
    stop: daemon.close,
  };
  const schema = JSON.stringify({
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  });
  function run(flags: string[], prompt = 'Respond with exactly: {"summary":"ok"}') {
    return runPaseoCli(context, [
      "--host",
      `127.0.0.1:${daemon.port}`,
      "run",
      "--provider",
      "codex",
      ...flags,
      prompt,
    ]);
  }

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const workspaceId = await mintLocalWorkspace(client, cwd);
    await client.setWorkspaceTitle(workspaceId, "Release work");
    const before = await workspaceIds(client);

    const structured = await run(["--cwd", `${cwd}/`, "--json", "--output-schema", schema]);
    expect(structured.exitCode, structured.stderr).toBe(0);
    const answer = JSON.parse(structured.stdout);
    expect(answer).toEqual({ agentId: expect.any(String), output: { summary: "ok" } });
    const agent = await client.fetchAgent({ agentId: answer.agentId });
    expect(agent?.agent.workspaceId).toBe(workspaceId);
    expect(agent?.agent.cwd).toBe(cwd);
    expect(await workspaceIds(client)).toEqual(before);

    const repeated = await run(["--cwd", cwd, "--json", "--background"]);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    const repeatedAgent = await client.fetchAgent({ agentId: JSON.parse(repeated.stdout).agentId });
    expect(repeatedAgent?.agent.workspaceId).toBe(workspaceId);
    expect(await workspaceIds(client)).toEqual(before);

    const legacy = await run(["--cwd", cwd, "--output-schema", schema]);
    expect(legacy.exitCode, legacy.stderr).toBe(0);
    expect(JSON.parse(legacy.stdout)).toEqual({ summary: "ok" });
    expect(await workspaceIds(client)).toEqual(before);

    const failure = await run(
      ["--cwd", cwd, "--json", "--output-schema", schema],
      "Emit a turn failure",
    );
    expect(failure.exitCode).toBe(1);
    const errorStart = failure.stderr.indexOf('{\n  "error"');
    expect(errorStart).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(failure.stderr.slice(errorStart))).toMatchObject({
      error: { code: "OUTPUT_SCHEMA_FAILED" },
    });
    expect(failure.stdout).toBe("");
    expect(await workspaceIds(client)).toEqual(before);

    const separate = await run([
      "--cwd",
      cwd,
      "--new-workspace",
      "local",
      "--json",
      "--background",
    ]);
    expect(separate.exitCode, separate.stderr).toBe(0);
    const separateAgent = await client.fetchAgent({ agentId: JSON.parse(separate.stdout).agentId });
    expect(separateAgent?.agent.workspaceId).not.toBe(workspaceId);
    expect((await workspaceIds(client)).size).toBe(before.size + 1);

    const newCwd = mkdtempSync(path.join(cwd, "another-directory-"));
    const firstRun = await run(["--cwd", newCwd, "--json", "--background"]);
    expect(firstRun.exitCode, firstRun.stderr).toBe(0);
    const firstAgent = await client.fetchAgent({ agentId: JSON.parse(firstRun.stdout).agentId });
    expect(firstAgent?.agent.cwd).toBe(newCwd);
    expect(firstAgent?.agent.workspaceId).toEqual(expect.any(String));
    const afterNewDirectory = await workspaceIds(client);
    expect(afterNewDirectory.size).toBe(before.size + 2);

    const secondRun = await run(["--cwd", `${newCwd}/`, "--json", "--background"]);
    expect(secondRun.exitCode, secondRun.stderr).toBe(0);
    const secondAgent = await client.fetchAgent({ agentId: JSON.parse(secondRun.stdout).agentId });
    expect(secondAgent?.agent.workspaceId).toBe(firstAgent?.agent.workspaceId);
    expect(await workspaceIds(client)).toEqual(afterNewDirectory);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { ProjectDispatchMapSchema } from "@getpaseo/protocol/project-dispatch";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadConfig } from "../config.js";
import { editPersistedConfig } from "../persisted-config.js";
import { fixture } from "../test-utils/ledger-routing.js";

const template = () => ({
  enableId: randomUUID(),
  hostId: "srv_test",
  daemonHome: "/workspace/example",
  ledgerRoot: "/workspace/ledgers",
  leadId: randomUUID(),
  maxParallel: 1,
  roles: [
    {
      role: "implementation",
      owner: "builders",
      provider: "codex",
      model: "test-model",
      mode: "auto",
    },
  ],
});
test("8,13: only the owner can change dispatch templates, approvals or the global switch", async () => {
  const f = await fixture();
  try {
    const store = new DaemonConfigStore(
      f.root,
      MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
    );
    store.setDispatchOwnerAdmission(() => f.manager.assertDispatchOwner());
    const parsed = ProjectDispatchMapSchema.parse({ sample: template() });
    expect(parsed.sample.enabled).toBe(false);
    await expect(
      f.manager.withAgentCaller(f.lead.id, () =>
        f.manager.trustedPlugins.rpc(undefined, async () =>
          store.patch({ projectDispatch: parsed }),
        ),
      ),
    ).rejects.toThrow("Only the owner");
    await expect(
      f.manager.withAgentCaller(f.lead.id, () =>
        f.manager.trustedPlugins.rpc(undefined, async () =>
          store.patch({ ledgerDispatchEnabled: true }),
        ),
      ),
    ).rejects.toThrow("Only the owner");
    f.manager.trustedPlugins.rpc(undefined, () =>
      store.patch({ projectDispatch: parsed, ledgerDispatchEnabled: true }),
    );
    expect(loadConfig(f.root, { env: {} }).ledgerDispatchEnabled).toBe(true);
    f.manager.trustedPlugins.rpc(undefined, () =>
      store.patch({ projectDispatch: {}, ledgerDispatchEnabled: false }),
    );
    expect(store.get().projectDispatch).toEqual({});
    expect(loadConfig(f.root, { env: {} }).ledgerDispatchEnabled).toBe(false);
  } finally {
    await f.cleanup();
  }
});
test("8: the local config CLI also refuses dispatch edits from an agent environment, including ancestor replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dispatch-owner-"));
  try {
    vi.stubEnv("PASEO_AGENT_ID", randomUUID());
    expect(() =>
      editPersistedConfig(root, "daemon.ledgerDispatchEnabled", { value: true }),
    ).toThrow("Only the owner");
    expect(() =>
      editPersistedConfig(root, "daemon", { value: { ledgerDispatchEnabled: true } }),
    ).toThrow("Only the owner");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
test("required host, owner, budget and restricted template values fail closed", () => {
  expect(() => ProjectDispatchMapSchema.parse({ "../sample": template() })).toThrow();
  expect(() =>
    ProjectDispatchMapSchema.parse({ sample: { ...template(), maxParallel: 0 } }),
  ).toThrow();
  expect(() =>
    ProjectDispatchMapSchema.parse({ sample: { ...template(), hostId: "unknown" } }),
  ).toThrow();
  expect(() =>
    ProjectDispatchMapSchema.parse({ sample: { ...template(), leadId: "unknown" } }),
  ).toThrow();
});
test("8: an agent cannot enable dispatch through a file edit followed by daemon reload", async () => {
  const f = await fixture();
  try {
    const base = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      ledgerDispatchEnabled: false,
    });
    const store = new DaemonConfigStore(f.root, base, undefined, {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: MutableDaemonConfigSchema.parse({
            ...base,
            projectDispatch: persisted.daemon?.projectDispatch,
            ledgerDispatchEnabled: persisted.daemon?.ledgerDispatchEnabled,
          }),
          overrideControlledPaths: [],
        }),
      },
    });
    store.setDispatchOwnerAdmission(() => f.manager.assertDispatchOwner());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(f.root, "config.json"),
      JSON.stringify({ daemon: { ledgerDispatchEnabled: true } }),
    );
    await expect(
      f.manager.withAgentCaller(f.lead.id, () =>
        f.manager.trustedPlugins.rpc(undefined, async () => store.reload()),
      ),
    ).rejects.toThrow("Only the owner");
    expect(store.get().ledgerDispatchEnabled).toBe(false);
    f.manager.trustedPlugins.rpc(undefined, () => store.reload());
    expect(store.get().ledgerDispatchEnabled).toBe(true);
  } finally {
    await f.cleanup();
  }
});

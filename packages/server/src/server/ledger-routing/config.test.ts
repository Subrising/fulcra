import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import type { ProjectDispatch } from "@getpaseo/protocol/messages";
import { MutableDaemonConfigSchema, ProjectDispatchMapSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { loadConfig } from "../config.js";

const template = {
  leadId: "00000000-0000-4000-8000-000000000001",
  maxParallel: 1,
  roles: [
    {
      role: "implementation",
      owner: "builders",
      provider: "codex",
      model: "test-model",
      mode: "full-access",
      cwd: "/workspace/example",
    },
  ],
} satisfies Omit<ProjectDispatch, "enabled" | "holdLabels">;

test("project dispatch defaults off, persists through the supported config path, and removes the complete map", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-dispatch-config-"));
  try {
    const store = new DaemonConfigStore(
      root,
      MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
    );
    expect(store.get().projectDispatch).toBeUndefined();
    store.patch({ projectDispatch: { sample: { ...template, enabled: false, holdLabels: [] } } });
    expect(loadConfig(root, { env: {} }).projectDispatch?.sample.enabled).toBe(false);
    const parsed = ProjectDispatchMapSchema.parse({ sample: template });
    expect(parsed.sample?.enabled).toBe(false);
    store.patch({ projectDispatch: { sample: { ...parsed.sample!, enabled: true } } });
    expect(loadConfig(root, { env: {} }).projectDispatch?.sample.enabled).toBe(true);
    store.patch({ projectDispatch: {} });
    expect(store.get().projectDispatch).toEqual({});
    expect(loadConfig(root, { env: {} }).projectDispatch).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project paths and missing dispatch limits fail configuration validation", () => {
  expect(() => ProjectDispatchMapSchema.parse({ "../sample": template })).toThrow();
  expect(() =>
    ProjectDispatchMapSchema.parse({ sample: { ...template, maxParallel: 0 } }),
  ).toThrow();
  expect(() =>
    ProjectDispatchMapSchema.parse({ sample: { ...template, leadId: "unknown" } }),
  ).toThrow();
});

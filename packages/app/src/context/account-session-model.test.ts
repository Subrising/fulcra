import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { ProviderUsageListPayload, AccountUsageRow } from "@/provider-usage/types";
import {
  contextAccountReadKey,
  contextSessionAccount,
  readContextAccounts,
} from "./account-session-model";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "session",
    provider: "codex",
    status: "idle",
    createdAt: new Date(0),
    updatedAt: new Date(1),
    labels: { "fulcra.account-name": "A" },
    runtimeInstanceId: "runtime-1",
    ...overrides,
  } as Agent;
}
function payload(accounts?: AccountUsageRow[]): ProviderUsageListPayload {
  return {
    requestId: "fake",
    fetchedAt: new Date(0).toISOString(),
    providers: [],
    ...(accounts ? { accounts } : {}),
  };
}
function key(current: Agent, generation = 1) {
  return contextAccountReadKey({
    serverId: "host",
    workspaceId: "workspace",
    clientGeneration: generation,
    admission: "read",
    agentId: current.id,
    agents: [current],
  });
}

describe("Context live account presentation", () => {
  it("uses only the row's wire label, never a saved login or parent assignment", () => {
    expect(contextSessionAccount(agent())).toEqual({ providerLabel: "Codex", name: "A" });
    expect(
      contextSessionAccount(agent({ labels: { savedLogin: "other", parentAccount: "parent" } })),
    ).toEqual({ providerLabel: "Codex", name: null });
    expect(
      contextSessionAccount(
        agent({ provider: "claude", labels: { "fulcra.account-name": "child-own" } }),
      ),
    ).toEqual({ providerLabel: "Claude", name: "child-own" });
    expect(contextSessionAccount(agent({ provider: "opencode" }))).toBeNull();
  });

  it("fences A-B-A and host reconnection even when the account label is the same", () => {
    const a = agent();
    expect(key(a)).not.toBe(
      key(agent({ runtimeInstanceId: "runtime-2", labels: { "fulcra.account-name": "B" } })),
    );
    expect(key(a)).not.toBe(key(agent({ runtimeInstanceId: "runtime-3" })));
    expect(key(a)).not.toBe(key(a, 2));
  });

  it("does not dispatch without current admission", async () => {
    const read = vi.fn(async () => payload([]));
    expect(await readContextAccounts(read, () => false)).toEqual({ kind: "superseded" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["revoked", "runtime replaced", "disconnected", "workspace changed"])(
    "rejects a held reply when %s",
    async () => {
      let resolve!: (value: ProviderUsageListPayload) => void;
      let current = true;
      const pending = readContextAccounts(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
        () => current,
      );
      current = false;
      resolve(payload([]));
      expect(await pending).toEqual({ kind: "superseded" });
    },
  );

  it("preserves immutable rows and optional counts despite equal display names", async () => {
    const rows = ["id-1", "id-2"].map((accountId, i) => ({
      accountId,
      provider: "codex",
      name: "same",
      status: "unavailable",
      source: null,
      observedAt: null,
      fiveHour: null,
      weekly: null,
      inUse: true,
      sessionCount: i === 0 ? 0 : undefined,
    })) as AccountUsageRow[];
    const result = await readContextAccounts(
      async () => payload(rows),
      () => true,
    );
    expect(result).toEqual({ kind: "ready", accounts: rows });
    if (result.kind !== "ready") throw new Error("expected rows");
    expect(result.accounts[0].sessionCount).toBe(0);
    expect(result.accounts[1].sessionCount).toBeUndefined();
    expect(Object.keys(result.accounts[0])).not.toContain("runtimeInstanceId");
  });

  it("distinguishes a complete empty roster from a missing account reply", async () => {
    expect(
      await readContextAccounts(
        async () => payload([]),
        () => true,
      ),
    ).toEqual({ kind: "ready", accounts: [] });
    expect(
      await readContextAccounts(
        async () => payload(),
        () => true,
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("drops provider error details and rejects failed reads after admission changes", async () => {
    expect(
      await readContextAccounts(
        async () => {
          throw new Error("fixture private detail");
        },
        () => true,
      ),
    ).toEqual({ kind: "unavailable" });
    let current = true;
    expect(
      await readContextAccounts(
        async () => {
          current = false;
          throw new Error("fixture private detail");
        },
        () => current,
      ),
    ).toEqual({ kind: "superseded" });
  });
});

import { describe, expect, it } from "vitest";
import { listAccounts, statusReason, switchAccountSession } from "./account.js";

function port(output: unknown) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    client: {
      fetchAgent: async () => ({ agent: { id: "resolved-session" } }),
      invokePluginRpc: async (_plugin: string, method: string, input: unknown) => {
        calls.push({ method, input });
        return output;
      },
    },
  };
}
describe("account commands", () => {
  it("lists only public account fields without a switch or provider prompt", async () => {
    const p = port({
      accounts: [
        {
          id: "personal",
          name: "Personal",
          provider: "codex",
          status: { state: "ok" },
          credential: "never return",
        },
      ],
    });
    expect(await listAccounts(p.client)).toEqual([
      { id: "personal", name: "Personal", provider: "codex", status: { state: "ok" } },
    ]);
    expect(p.calls).toEqual([{ method: "organization.accounts", input: {} }]);
  });
  it("resolves the selected session and uses the existing fenced switch", async () => {
    const p = port({ ok: true, message: 'Switched to account "Personal".' });
    expect(await switchAccountSession(p.client, "resolved", " Personal ")).toBe(
      'Switched to account "Personal".',
    );
    expect(p.calls).toEqual([
      {
        method: "organization.accounts.switch",
        input: { agentId: "resolved-session", account: "Personal" },
      },
    ]);
  });
  it("surfaces permission and pool refusals without reporting success", async () => {
    const p = port({ ok: false, message: "Ask the owner to allow account management" });
    await expect(switchAccountSession(p.client, "resolved", "Personal")).rejects.toThrow(
      "Ask the owner",
    );
  });
  it("retains local and remote limit sources in account listings", async () => {
    const p = port({
      accounts: [
        {
          id: "a",
          name: "Work",
          status: { state: "limited", until: "2026-10-15T14:00:00Z", source: "local" },
        },
        {
          id: "b",
          name: "Personal",
          status: { state: "limited", until: "2026-10-15T14:00:00Z", source: "peer" },
        },
      ],
    });
    expect((await listAccounts(p.client)).map((row) => row.status.source)).toEqual([
      "local",
      "peer",
    ]);
  });
  // FU-112: `account ls` says why an account is down.
  it("keeps the reason of a revoked account and shows it in the REASON column", async () => {
    const reason = "Failed to authenticate. API Error: 401 OAuth token has been revoked.";
    const p = port({
      accounts: [
        { id: "a", name: "Tommi", provider: "claude", status: { state: "revoked", reason } },
        {
          id: "b",
          name: "Work",
          provider: "claude",
          status: { state: "limited", until: "2026-10-13T00:00:00.000Z" },
        },
        { id: "c", name: "Personal", provider: "claude", status: { state: "ok" } },
      ],
    });
    const rows = await listAccounts(p.client);
    expect(rows[0].status).toEqual({ state: "revoked", reason });
    expect(rows.map((row) => statusReason(row.status))).toEqual([
      reason,
      "limit until 2026-10-13T00:00:00.000Z",
      "",
    ]);
    expect(statusReason({ state: "revoked" })).toBe("token revoked or invalid");
  });
});

it("revokes an account in one management request and returns deletion failures", async () => {
  const { revokeAccount } = await import("./account.js");
  const calls: unknown[] = [];
  const client = {
    fetchAgent: async () => null,
    invokePluginRpc: async (_plugin: string, method: string, input: unknown) => {
      calls.push({ method, input });
      return method === "organization.accounts"
        ? { accounts: [{ id: "account-id", name: "API fixture", status: { state: "ok" } }] }
        : { ok: false, message: "The account is blocked. Retry revoke." };
    },
  };
  await expect(revokeAccount(client, "API fixture")).rejects.toThrow("Retry revoke");
  expect(calls).toEqual([
    { method: "organization.accounts", input: {} },
    { method: "organization.accounts.update", input: { id: "account-id", revoke: true } },
  ]);
});

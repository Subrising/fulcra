import { describe, expect, it } from "vitest";
import { listAccounts, switchAccountSession } from "./account.js";

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
    const p = port({ ok: true, message: "Continued on Personal with its history." });
    expect(await switchAccountSession(p.client, "resolved", " Personal ")).toBe(
      "Continued on Personal with its history.",
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
});

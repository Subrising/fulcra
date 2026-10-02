import { useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { statusText } from "./accounts";
import { sessionAccountsRpc, accountSwitchRpc } from "../shared/accounts";

/**
 * W1: "Switch account…" for one session. It appears in the session's menu (the command center in a session) and as
 * /account in its chat: `/account` lists the accounts (it opens this menu), `/account <name>` switches to one. Only the
 * owner in the app reaches it; nothing here shows a credential.
 */
export const SWITCH_PANEL = "switch-account";
const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" } as const;
// U7 accounts.manage: a device the owner has not allowed to manage accounts is told plainly who to ask.
export const ownerAsk = (error: unknown) => {
  const m = error instanceof Error ? error.message : "";
  const i = m.indexOf("Ask the owner to allow account management");
  return i >= 0 ? m.slice(i, i + 200) : null;
};

// The outcome of a switch typed as /account <name>, shown when the menu it opens renders (one per session).
const notices = new Map<string, string>(),
  listeners = new Set<() => void>();
function setNotice(agentId: string, message: string) {
  notices.set(agentId, message);
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function SwitchAccountPanel({
  theme,
  agentId,
}: Pick<PluginAgentPanelProps, "theme" | "agentId">) {
  const read = useContract(sessionAccountsRpc),
    change = useContract(accountSwitchRpc);
  const qc = useQueryClient(),
    c = theme.colors,
    key = ["orca-organization", "session-accounts", agentId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => read({ agentId }),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const notice = useSyncExternalStore(subscribe, () => notices.get(agentId) ?? null);
  const [busy, setBusy] = useState(false);
  const use = async (id: string) => {
    setBusy(true);
    try {
      const r = await change({ agentId, account: id });
      setNotice(agentId, r.message ?? (r.ok ? "Switched." : "That did not work."));
    } catch {
      setNotice(agentId, "The account could not be switched. Try again in a moment.");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: key });
    }
  };
  const v = query.data;
  return (
    <ScrollView
      testID="switch-account"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: 12, gap: 10 }}
    >
      {!v && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.isPending
            ? "Reading this session’s accounts…"
            : (ownerAsk(query.error) ?? "This session’s accounts could not be read.")}
        </Text>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
      {v && !v.provider && (
        <Text style={{ color: c.foregroundMuted }}>
          This session’s provider has no account pool. Add accounts in Settings › Accounts &
          Defaults.
        </Text>
      )}
      {v?.provider && (
        <>
          <Text
            accessibilityRole="header"
            style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}
          >{`${PROVIDER_LABEL[v.provider]} accounts for this session`}</Text>
          {!v.accounts.length && (
            <Text
              style={{ color: c.foregroundMuted }}
            >{`No ${PROVIDER_LABEL[v.provider]} accounts yet. Add them in Settings › Accounts & Defaults.`}</Text>
          )}
          {v.accounts.map((a, i) => (
            <View
              key={a.id}
              style={{
                gap: 4,
                paddingVertical: 8,
                borderTopWidth: i ? 1 : 0,
                borderColor: c.border,
              }}
            >
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
              >
                <Text style={{ color: c.foreground, fontWeight: "700" }}>{a.name}</Text>
                <Text
                  testID={`switch-account-status-${a.id}`}
                  style={{
                    color:
                      a.status.state === "ok"
                        ? c.statusSuccess
                        : a.status.state === "limited"
                          ? c.statusWarning
                          : c.foregroundMuted,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  {statusText(a.status)}
                </Text>
                {a.isDefault && (
                  <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
                    Default for new sessions
                  </Text>
                )}
              </View>
              <View style={{ alignItems: "flex-start" }}>
                <WorkButton
                  theme={theme}
                  label={`Use ${a.name} for this session`}
                  selected={a.id === v.current}
                  disabled={busy || a.id === v.current || a.status.state !== "ok"}
                  onPress={() => void use(a.id)}
                >
                  {a.id === v.current ? "In use" : "Use this account"}
                </WorkButton>
              </View>
            </View>
          ))}
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
            The session carries on under the account you choose, with its history. Other sessions
            stay where they are. In the chat: /account lists these, /account name switches.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

type Client = Partial<
  Pick<PluginClientContext, "addWorkspacePanel" | "addCommandCenterItem" | "addSlashCommand">
>;
// Hosts that predate agent panels get none of it: every entry opens the panel.
export function registerAccountSwitch(client: Client) {
  if (typeof client.addWorkspacePanel !== "function") return () => {};
  const off = [
    client.addWorkspacePanel({
      id: SWITCH_PANEL,
      title: "Switch account…",
      icon: "Users",
      context: "agent",
      Component: SwitchAccountPanel,
    }),
  ];
  if (typeof client.addCommandCenterItem === "function")
    off.push(
      client.addCommandCenterItem({
        id: "switch-account",
        context: "agent",
        title: "Switch account…",
        icon: "Users",
        keywords: ["account", "subscription", "limit", "claude", "codex"],
        onSelect: (ctx) => ctx.openPanel(SWITCH_PANEL),
      }),
    );
  if (typeof client.addSlashCommand === "function")
    off.push(
      client.addSlashCommand({
        name: "account",
        context: "agent",
        description: "List this session’s accounts, or switch it to one",
        argumentHint: "[account name]",
        async onSubmit(ctx) {
          const name = ctx.args.trim();
          if (name) {
            try {
              const r = (await ctx.rpc(accountSwitchRpc as any, {
                agentId: ctx.agent.id,
                account: name.slice(0, 80),
              })) as { ok: boolean; message: string | null };
              setNotice(ctx.agent.id, r.message ?? (r.ok ? "Switched." : "That did not work."));
            } catch {
              setNotice(ctx.agent.id, "The account could not be switched. Try again in a moment.");
            }
          }
          ctx.openPanel(SWITCH_PANEL);
        },
      }),
    );
  return () => off.forEach((dispose) => dispose());
}

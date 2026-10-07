import { useState, type ReactNode } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { UsageRundown } from "./usage-rundown";
import {
  accountsRpc,
  accountAddRpc,
  accountUpdateRpc,
  poolSettingsRpc,
  DEFAULT_ROLES,
  type AccountsView,
  type DefaultRole,
} from "../shared/accounts";
// U7 accounts.manage: the plain "ask the owner" refusal a device without account management receives.
const ownerAsk = (error: unknown) => {
  const m = error instanceof Error ? error.message : "";
  const i = m.indexOf("Ask the owner to allow account management");
  return i >= 0 ? m.slice(i, i + 200) : null;
};

/**
 * Update-7: Settings › Accounts & models. Fulcra's own pool of Claude and Codex subscription accounts (many at once:
 * a new session takes one by the pool's order and skips any that are limited; a session stopped by a usage limit waits
 * for its account's reset, or moves to the next account with its history when the owner turns that on), and the model +
 * effort each role starts with. Nothing here shows a credential:
 * a Claude token goes in once, to the Keychain on the host, and is never shown again.
 */
type Props = Pick<PluginSurfaceProps, "theme" | "layout" | "host">;
const ROLE_LABEL: Record<DefaultRole, string> = {
  orchestration: "Main assistant and project leads",
  planning: "Planners",
  review: "Reviewers",
  implementation: "Implementers",
  research: "Research",
};
const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" } as const;
// Update-7 W3: plain names for the permission modes Settings offers (bypassPermissions is never offered).
const MODE_LABEL: Record<string, string> = {
  auto: "Auto",
  acceptEdits: "Accept edits",
  default: "Always ask",
  plan: "Plan only",
  "full-access": "Full access",
  "auto-review": "Auto-review",
};
const MODE_HELP: Record<string, string> = {
  auto: "Claude reviews risky actions itself; no routine prompts.",
  acceptEdits: "File edits go ahead; other actions ask.",
  default: "Asks before every action.",
  plan: "Plans only; changes nothing.",
  "full-access":
    "Codex Full Access runs commands without approval prompts. Fulcra cannot pre-check credential access, destructive Git actions or publishing in this mode.",
  "auto-review": "Workspace access; eligible approvals go to Codex's auto-reviewer.",
};
const when = (iso: string | null | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t)
    ? new Date(t).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "unknown";
};
export function statusText(s: AccountsView["accounts"][number]["status"]) {
  switch (s.state) {
    case "ok":
      return "Ready";
    case "limited":
      return `Limited until ${when(s.until)}`;
    case "auth-expired":
      return "Signed out: add its token again";
    case "signing-in":
      return "Signing in…";
    default:
      return "Turned off";
  }
}
export function AccountsSurface({ theme, layout, host }: Props) {
  const read = useContract(accountsRpc),
    add = useContract(accountAddRpc),
    update = useContract(accountUpdateRpc),
    settings = useContract(poolSettingsRpc);
  const qc = useQueryClient(),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "accounts"],
    queryFn: () => read({}),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<{ ok: boolean; message: string | null }>) => {
    setBusy(true);
    try {
      const r = await run();
      setNotice(r.message ?? (r.ok ? "Saved." : "That did not work."));
    } catch {
      setNotice("That could not be saved. Try again in a moment.");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["orca-organization", "accounts"] });
    }
  };
  const v = query.data;
  const box = (children: ReactNode, key?: string) => (
    <View
      key={key}
      style={{
        gap: 8,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
      }}
    >
      {children}
    </View>
  );
  return (
    <ScrollView
      testID="accounts-settings"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 12 : 24,
        gap: 16,
        maxWidth: 820,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 4 }}>
        {/* The Settings page above already shows the "Accounts & models" title and its one-line description. */}
        <Text style={{ color: c.foregroundMuted }}>
          Sessions share your subscription accounts. When an account reaches its usage limit, its
          sessions wait for that account to reset, unless you choose to continue on another account
          below.
        </Text>
      </View>
      {!v && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.isPending
            ? "Reading your accounts…"
            : (ownerAsk(query.error) ?? "Your accounts could not be read.")}
        </Text>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
      <UsageRundown theme={theme} hostId={host.id} />
      {v &&
        (["claude", "codex"] as const).map((provider) => {
          const list = v.accounts
              .filter((a) => a.provider === provider)
              .sort((a, b) => a.priority - b.priority),
            all = v.allLimited[provider];
          return box(
            <>
              <Text
                accessibilityRole="header"
                style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}
              >
                {PROVIDER_LABEL[provider]} accounts
              </Text>
              {!list.length && (
                <Text style={{ color: c.foregroundMuted }}>
                  No {PROVIDER_LABEL[provider]} accounts yet. Sessions use this Mac's own sign-in
                  until you add one.
                </Text>
              )}
              {all && (
                <Text
                  testID={`accounts-all-limited-${provider}`}
                  style={{ color: c.statusWarning }}
                >{`Every ${PROVIDER_LABEL[provider]} account is limited. The first one resets ${when(all)}; sessions wait until then.`}</Text>
              )}
              {list.map((a, i) => (
                <View
                  key={a.id}
                  testID={`account-${a.id}`}
                  style={{
                    gap: 6,
                    paddingVertical: 8,
                    borderTopWidth: i ? 1 : 0,
                    borderColor: c.border,
                  }}
                >
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
                  >
                    <Text
                      style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}
                    >{`${i + 1}. ${a.name}`}</Text>
                    <Text
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
                  </View>
                  <Text
                    style={{ color: c.foregroundMuted }}
                  >{`${a.sessions.length} session${a.sessions.length === 1 ? "" : "s"} using it now${a.lastUsedAt ? ` · last used ${when(a.lastUsedAt)}` : ""}${a.limitNote ? ` · ${a.limitNote}` : ""}`}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {i > 0 && (
                      <WorkButton
                        theme={theme}
                        label={`Move ${a.name} up`}
                        disabled={busy}
                        onPress={() => void act(() => update({ id: a.id, move: "up" }))}
                      >
                        Move up
                      </WorkButton>
                    )}
                    {i < list.length - 1 && (
                      <WorkButton
                        theme={theme}
                        label={`Move ${a.name} down`}
                        disabled={busy}
                        onPress={() => void act(() => update({ id: a.id, move: "down" }))}
                      >
                        Move down
                      </WorkButton>
                    )}
                    <WorkButton
                      theme={theme}
                      label={`${a.enabled ? "Turn off" : "Turn on"} ${a.name}`}
                      disabled={busy}
                      onPress={() => void act(() => update({ id: a.id, enabled: !a.enabled }))}
                    >
                      {a.enabled ? "Turn off" : "Turn on"}
                    </WorkButton>
                    {a.status.state === "limited" && (
                      <WorkButton
                        theme={theme}
                        label={`Try ${a.name} again now`}
                        disabled={busy}
                        onPress={() => void act(() => update({ id: a.id, clearLimit: true }))}
                      >
                        Try again now
                      </WorkButton>
                    )}
                    {provider === "codex" && a.status.state !== "ok" && (
                      <WorkButton
                        theme={theme}
                        label={`Sign in to ${a.name} again`}
                        disabled={busy}
                        onPress={() => void act(() => update({ id: a.id, signIn: true }))}
                      >
                        Sign in again
                      </WorkButton>
                    )}
                    <WorkButton
                      theme={theme}
                      label={`Remove ${a.name}`}
                      disabled={busy}
                      onPress={() => void act(() => update({ id: a.id, remove: true }))}
                    >
                      Remove
                    </WorkButton>
                  </View>
                  {provider === "claude" && a.status.state === "auth-expired" && (
                    <TokenField
                      theme={theme}
                      label={`New token for ${a.name}`}
                      busy={busy}
                      onSubmit={(token) => act(() => update({ id: a.id, token }))}
                    />
                  )}
                </View>
              ))}
              {list.length > 0 && (
                <View
                  testID={`default-account-${provider}`}
                  style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderColor: c.border }}
                >
                  <Text
                    style={{ color: c.foreground, fontWeight: "600" }}
                  >{`New ${PROVIDER_LABEL[provider]} sessions use`}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    <WorkButton
                      theme={theme}
                      label={`New ${PROVIDER_LABEL[provider]} sessions use the first ready account`}
                      selected={!v.defaultAccounts?.[provider]}
                      disabled={busy}
                      onPress={() =>
                        void act(() => settings({ defaultAccount: { provider, id: null } }))
                      }
                    >
                      The first ready account
                    </WorkButton>
                    {list.map((a) => (
                      <WorkButton
                        key={a.id}
                        theme={theme}
                        label={`New ${PROVIDER_LABEL[provider]} sessions use ${a.name}`}
                        selected={v.defaultAccounts?.[provider] === a.id}
                        disabled={busy}
                        onPress={() =>
                          void act(() => settings({ defaultAccount: { provider, id: a.id } }))
                        }
                      >
                        {a.name}
                      </WorkButton>
                    ))}
                  </View>
                  <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
                    Every new session takes this account while it is ready, however it is started.
                    When it is limited or off, the order above decides. A session can move to
                    another account from its menu: Switch account…
                  </Text>
                </View>
              )}
              <AddAccount
                provider={provider}
                theme={theme}
                busy={busy}
                onAdd={(name, token) =>
                  act(() => add({ provider, name, ...(token ? { token } : {}) }))
                }
              />
            </>,
            provider,
          );
        })}
      {v &&
        box(
          <>
            <Text
              accessibilityRole="header"
              style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}
            >
              Which account a new session takes
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <WorkButton
                theme={theme}
                label="In order: the first ready account"
                selected={v.policy === "priority"}
                disabled={busy}
                onPress={() => void act(() => settings({ policy: "priority" }))}
              >
                In order
              </WorkButton>
              <WorkButton
                theme={theme}
                label="Spread: the ready account with the fewest sessions"
                selected={v.policy === "spread"}
                disabled={busy}
                onPress={() => void act(() => settings({ policy: "spread" }))}
              >
                Spread evenly
              </WorkButton>
            </View>
            {v.rotations.length > 0 && (
              <Text style={{ color: c.foregroundMuted }}>{`Recent moves: ${v.rotations
                .slice(-3)
                .toReversed()
                .map((r) =>
                  r.to
                    ? `${when(r.at)}${r.reason === "manual" ? " (your switch)" : ""} ${r.from ? `from ${r.from} ` : ""}to ${r.to}`
                    : `${when(r.at)} ${r.from} limited, waiting for its reset`,
                )
                .join("; ")}`}</Text>
            )}
          </>,
          "policy",
        )}
      {v &&
        box(
          <>
            <Text
              accessibilityRole="header"
              style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}
            >
              When an account hits its limit
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <WorkButton
                theme={theme}
                label="Wait for its reset: sessions stay on their account"
                selected={v.rotateOnLimit !== true}
                disabled={busy}
                onPress={() => void act(() => settings({ rotateOnLimit: false }))}
              >
                Wait for its reset
              </WorkButton>
              <WorkButton
                theme={theme}
                label="Continue on another account: uses that account's usage"
                selected={v.rotateOnLimit === true}
                disabled={busy}
                onPress={() => void act(() => settings({ rotateOnLimit: true }))}
              >
                Continue on another account
              </WorkButton>
            </View>
            <Text style={{ color: c.foregroundMuted }}>
              Continuing on another account uses up that account's usage too.
            </Text>
          </>,
          "limit",
        )}
      {v &&
        box(
          <>
            <Text
              accessibilityRole="header"
              style={{ color: c.foreground, fontWeight: "700", fontSize: 18 }}
            >
              Model and effort by role
            </Text>
            <Text style={{ color: c.foregroundMuted }}>
              Every new session starts with its role's model and effort, wherever it is created:
              here, by a lead, or from the command line. Only what the installed provider offers is
              listed.
            </Text>
            {DEFAULT_ROLES.map((role) => (
              <RoleRow
                key={role}
                role={role}
                view={v}
                theme={theme}
                busy={busy}
                onSave={(defaults) => act(() => settings({ role, defaults }))}
              />
            ))}
            <Text
              accessibilityRole="header"
              style={{ color: c.foreground, fontWeight: "700", fontSize: 16, paddingTop: 8 }}
            >
              Permission mode for new sessions
            </Text>
            <Text style={{ color: c.foregroundMuted }}>
              Every new session starts in this mode, wherever it is created. A mode chosen for one
              session still wins.
            </Text>
            {(["claude", "codex"] as const).map((p) => (
              <View
                key={p}
                testID={`default-mode-${p}`}
                style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: c.border }}
              >
                <Text
                  style={{ color: c.foreground, fontWeight: "600" }}
                >{`${PROVIDER_LABEL[p]} · ${MODE_LABEL[v.defaults.modes[p]] ?? v.defaults.modes[p]}`}</Text>
                <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
                  {MODE_HELP[v.defaults.modes[p]] ?? ""}
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {v.defaults.modeChoices[p].map((m) => (
                    <WorkButton
                      key={m}
                      theme={theme}
                      label={`${PROVIDER_LABEL[p]} permission mode ${MODE_LABEL[m] ?? m}`}
                      selected={v.defaults.modes[p] === m}
                      disabled={busy}
                      onPress={() => void act(() => settings({ mode: { provider: p, modeId: m } }))}
                    >
                      {MODE_LABEL[m] ?? m}
                    </WorkButton>
                  ))}
                </View>
              </View>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <WorkButton
                theme={theme}
                label="Leads must start sessions for implementation and review, not subagents"
                selected={v.defaults.orchestrationGuard}
                disabled={busy}
                onPress={() =>
                  void act(() => settings({ orchestrationGuard: !v.defaults.orchestrationGuard }))
                }
              >
                {v.defaults.orchestrationGuard
                  ? "Leads use sessions only: on"
                  : "Leads use sessions only: off"}
              </WorkButton>
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
              On: a lead's request to have a subagent write or review code is refused, and it starts
              a worker session instead, which shows in Sessions under the lead.
            </Text>
          </>,
          "roles",
        )}
    </ScrollView>
  );
}
function TokenField({
  theme,
  label,
  busy,
  onSubmit,
}: {
  theme: Props["theme"];
  label: string;
  busy: boolean;
  onSubmit: (token: string) => void;
}) {
  const [token, setToken] = useState(""),
    c = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      <TextInput
        accessibilityLabel={label}
        placeholder="Token from `claude setup-token`"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
        maxLength={1024}
        style={{
          color: c.foreground,
          minHeight: 44,
          padding: 10,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 10,
          backgroundColor: c.surface0,
        }}
      />
      <View style={{ alignItems: "flex-start" }}>
        <WorkButton
          theme={theme}
          label={`Save ${label.toLowerCase()}`}
          disabled={busy || !token.trim()}
          onPress={() => {
            onSubmit(token.trim());
            setToken("");
          }}
        >
          Save token
        </WorkButton>
      </View>
    </View>
  );
}
function AddAccount({
  provider,
  theme,
  busy,
  onAdd,
}: {
  provider: "claude" | "codex";
  theme: Props["theme"];
  busy: boolean;
  onAdd: (name: string, token?: string) => void;
}) {
  const [name, setName] = useState(""),
    [token, setToken] = useState(""),
    c = theme.colors;
  const field = {
    color: c.foreground,
    minHeight: 44,
    padding: 10,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    backgroundColor: c.surface0,
  };
  return (
    <View style={{ gap: 6, paddingTop: 8 }}>
      <Text
        style={{ color: c.foreground, fontWeight: "600" }}
      >{`Add a ${PROVIDER_LABEL[provider]} account`}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
        {provider === "claude"
          ? "On the Mac that runs this host, run `claude setup-token` in Terminal and sign in to the account once. Paste the token it prints here. It is kept in the Keychain and never shown again."
          : "A browser sign-in opens on the Mac that runs this host. Sign in to the account there once."}
      </Text>
      <TextInput
        accessibilityLabel={`${PROVIDER_LABEL[provider]} account name`}
        placeholder="Name, for example Work"
        value={name}
        onChangeText={setName}
        maxLength={60}
        style={field}
      />
      {provider === "claude" && (
        <TextInput
          accessibilityLabel="Claude account token"
          placeholder="Token from `claude setup-token`"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={token}
          onChangeText={setToken}
          maxLength={1024}
          style={field}
        />
      )}
      <View style={{ alignItems: "flex-start" }}>
        <WorkButton
          theme={theme}
          label={`Add ${PROVIDER_LABEL[provider]} account`}
          disabled={busy || !name.trim() || (provider === "claude" && !token.trim())}
          onPress={() => {
            onAdd(name.trim(), provider === "claude" ? token.trim() : undefined);
            setName("");
            setToken("");
          }}
        >
          {provider === "claude" ? "Add account" : "Add and sign in"}
        </WorkButton>
      </View>
    </View>
  );
}
function RoleRow({
  role,
  view,
  theme,
  busy,
  onSave,
}: {
  role: DefaultRole;
  view: AccountsView;
  theme: Props["theme"];
  busy: boolean;
  onSave: (d: AccountsView["defaults"]["roles"][DefaultRole]) => void;
}) {
  const cur = view.defaults.roles[role],
    c = theme.colors;
  const provider = cur?.provider ?? "claude",
    sel = cur?.[provider],
    models = view.catalog[provider] ?? [];
  const model = models.find((m) => m.id === sel?.model) ?? null,
    efforts = (model ?? models[0])?.efforts ?? [];
  const save = (
    patch: Partial<{
      provider: "claude" | "codex";
      model: string | null;
      thinkingOptionId: string | null;
    }>,
  ) => {
    const p = patch.provider ?? provider,
      base = {
        provider: p,
        claude: cur?.claude ?? { model: null, thinkingOptionId: null },
        codex: cur?.codex ?? { model: null, thinkingOptionId: null },
      };
    const next = {
      ...base[p],
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinkingOptionId !== undefined ? { thinkingOptionId: patch.thinkingOptionId } : {}),
    };
    // An effort the chosen model does not offer is dropped (the provider's default applies).
    const offered = models.find((m) => m.id === next.model)?.efforts;
    if (
      patch.model !== undefined &&
      offered &&
      next.thinkingOptionId &&
      !offered.includes(next.thinkingOptionId)
    )
      next.thinkingOptionId = null;
    onSave({ ...base, provider: p, [p]: next });
  };
  return (
    <View
      testID={`role-defaults-${role}`}
      style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: c.border }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{ROLE_LABEL[role]}</Text>
      <Text
        style={{ color: c.foregroundMuted, fontSize: 13 }}
      >{`${PROVIDER_LABEL[provider]} · ${model?.label ?? sel?.model ?? "the provider's default model"} · ${sel?.thinkingOptionId ? `${sel.thinkingOptionId} effort` : "default effort"}`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["claude", "codex"] as const).map((p) => (
          <WorkButton
            key={p}
            theme={theme}
            label={`${ROLE_LABEL[role]}: ${PROVIDER_LABEL[p]}`}
            selected={provider === p}
            disabled={busy}
            onPress={() => save({ provider: p })}
          >
            {PROVIDER_LABEL[p]}
          </WorkButton>
        ))}
      </View>
      {models.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {models.slice(0, 8).map((m) => (
            <WorkButton
              key={m.id}
              theme={theme}
              label={`${ROLE_LABEL[role]} model ${m.label}`}
              selected={sel?.model === m.id}
              disabled={busy}
              onPress={() => save({ model: m.id })}
            >
              {m.label}
            </WorkButton>
          ))}
        </View>
      )}
      {efforts.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {efforts.map((e) => (
            <WorkButton
              key={e}
              theme={theme}
              label={`${ROLE_LABEL[role]} effort ${e}`}
              selected={sel?.thinkingOptionId === e}
              disabled={busy}
              onPress={() => save({ thinkingOptionId: e })}
            >
              {e}
            </WorkButton>
          ))}
        </View>
      )}
      {!models.length && (
        <Text
          style={{ color: c.foregroundMuted, fontSize: 13 }}
        >{`${PROVIDER_LABEL[provider]}'s models could not be listed on this host right now.`}</Text>
      )}
    </View>
  );
}

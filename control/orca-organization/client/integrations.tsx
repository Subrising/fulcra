import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { openTrackerUrl, openHelpUrl } from "./tracker-link";
import { integrationsRpc, type Integrations } from "../shared/cc/connectors";
// Fulcra J4 Settings › Integrations (CONTRACTS §7.2, CC-PLAN D2 "the way Kepler does it"). One card per tracker:
// Connect (a code sign-in where the host supports it, or paste a token with a link to create one and the
// permissions it needs), its accounts, and a warning plus Reconnect when a sign-in stops working.
// J4b: Jira and Bitbucket, Cloud and Data Center. What a token sign-in asks for besides the token is per connector
// (TOKEN_FIELDS): the site, and the Atlassian account email or the Bitbucket Data Center username the host sends
// with the token. A `revoked` account is one whose Disconnect was not confirmed by the keychain: "Couldn't remove; retry".
// Sign-in goes to the host's shared credential store (J5b P1). A pasted token lives only in this form's state
// until it is handed to the host, and is cleared straight after. A host without P1 shows why and what still works.
type Theme = PluginSurfaceProps["theme"];
type Connector = Integrations["connectors"][number];
type Account = Integrations["accounts"][number];
interface Flow {
  flowId: string;
  userCode?: string;
  verifyUrl?: string;
}
interface Credentials {
  begin(input: { connector: string; method: string; site?: string }): Promise<Flow>;
  // `email` is the Atlassian account email (Jira and Bitbucket Cloud) or the Bitbucket Data Center username.
  complete(input: {
    flowId?: string;
    input: { kind: "token"; token: string; email?: string } | { kind: "poll" };
  }): Promise<
    | { status: "pending"; retryAfterSeconds: number }
    | { status: "connected"; account: { displayName: string } }
  >;
  reconnect(input: { accountId: string; method?: string }): Promise<Flow>;
  remove(accountId: string): Promise<unknown>;
}
export const NEEDS_P1 = "This needs Fulcra host update P1.";
// The host API, if this Fulcra host has it. Older hosts have no usePaseo, or no credentials on it.
export function useHostCredentials(): Credentials | null {
  const use = (pluginClient as { usePaseo?: () => { credentials?: Credentials } }).usePaseo;
  try {
    return use?.()?.credentials ?? null;
  } catch {
    return null;
  }
}
const STATE: Record<Account["state"], { text: string; warn: boolean }> = {
  connected: { text: "Connected", warn: false },
  expired: { text: "Sign-in expired", warn: true },
  "needs-reconnect": { text: "Sign-in stopped working", warn: true },
  // CONTRACTS v1.10: Disconnect was asked for and the keychain has not confirmed the removal yet.
  revoked: { text: "Couldn't remove; retry", warn: true },
};
type Field = "required" | "optional";
// What a token sign-in needs besides the token (the host's providers: requiresSite, requiresEmail, acceptsUsername).
// Any other self-hosted connector needs its site.
export const TOKEN_FIELDS: Record<
  string,
  { site?: Field; email?: Field; emailLabel?: string; sitePlaceholder?: string }
> = {
  jira: {
    site: "required",
    sitePlaceholder: "your-site.atlassian.net",
    email: "required",
    emailLabel: "The email address of your Atlassian account",
  },
  "jira-dc": { site: "required", sitePlaceholder: "jira.example.com" },
  bitbucket: { email: "required", emailLabel: "The email address of your Atlassian account" },
  "bitbucket-dc": {
    site: "required",
    sitePlaceholder: "bitbucket.example.com",
    email: "optional",
    emailLabel: "Your Bitbucket username (only for a personal token)",
  },
};
export const tokenFields = (connector: Pick<Connector, "id" | "selfHosted">) =>
  TOKEN_FIELDS[connector.id] ??
  (connector.selfHosted
    ? { site: "required" as const, sitePlaceholder: "tracker.example.com" }
    : {});
const plain = (error: unknown) => {
  const m = error instanceof Error ? error.message : "";
  return m && m.length < 200 && !/[{}<>]/.test(m) ? m : "That did not work. Nothing was changed.";
};

export function IntegrationsScreen({
  theme,
  layout,
}: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const read = useContract(integrationsRpc),
    credentials = useHostCredentials(),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["fulcra-integrations"],
    queryFn: () => read({}),
    retry: false,
    staleTime: 15000,
  });
  const data = query.data,
    hostApi = !!data?.hostApi && !!credentials;
  return (
    <ScrollView
      testID="integrations"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout?.compact ? 16 : 24, gap: 16, maxWidth: 880 }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: c.foreground, fontSize: 26, fontWeight: "600" }}
      >
        Integrations
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        Connect the places where your team keeps issues and pull requests. Fulcra only reads them.
        It never changes anything there.
      </Text>
      {query.isError && (
        <Text style={{ color: c.foreground }}>
          Integrations could not be loaded. Try again in a moment.
        </Text>
      )}
      {data && !hostApi && (
        <Notice
          theme={theme}
          testID="integrations-needs-p1"
          title={NEEDS_P1}
          text="Until it is installed, Fulcra cannot keep sign-ins for your trackers. GitHub can still be read through the GitHub command-line login on this computer, and earlier set-ups keep working."
        />
      )}
      {data?.connectors.map((connector) => (
        <ConnectorCard
          key={connector.id}
          theme={theme}
          connector={connector}
          hostApi={hostApi}
          credentials={credentials}
          accounts={data.accounts.filter((a) => a.connector === connector.id)}
          onChanged={() => {
            void query.refetch();
          }}
        />
      ))}
    </ScrollView>
  );
}

function Notice({
  theme,
  title,
  text,
  testID,
}: {
  theme: Theme;
  title: string;
  text: string;
  testID?: string;
}) {
  const c = theme.colors;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={{
        gap: 4,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.statusWarning ?? c.border,
        backgroundColor: c.surface1 ?? c.surface0,
      }}
    >
      <Text style={{ color: c.foreground, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: c.foregroundMuted }}>{text}</Text>
    </View>
  );
}

function ConnectorCard({
  theme,
  connector,
  accounts,
  hostApi,
  credentials,
  onChanged,
}: {
  theme: Theme;
  connector: Connector;
  accounts: Account[];
  hostApi: boolean;
  credentials: Credentials | null;
  onChanged: () => void;
}) {
  const c = theme.colors;
  const [open, setOpen] = useState<null | { reconnect: Account | null }>(null),
    [notice, setNotice] = useState<string | null>(null),
    [confirm, setConfirm] = useState<string | null>(null);
  const kinds = connector.kinds.includes("pr")
    ? connector.kinds.includes("issue")
      ? "Issues and pull requests"
      : "Pull requests"
    : "Tickets";
  const remove = async (account: Account) => {
    setConfirm(null);
    // A failed removal leaves the account `revoked`: the refetch shows "Couldn't remove; retry" on its row.
    try {
      await credentials!.remove(account.id);
      setNotice(`${account.displayName} was disconnected.`);
    } catch (error) {
      setNotice(plain(error));
    } finally {
      onChanged();
    }
  };
  return (
    <View
      testID={`integration-${connector.id}`}
      style={{
        gap: 12,
        padding: 16,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1 ?? c.surface0,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 18, fontWeight: "600" }}>
            {connector.label}
          </Text>
          <Text style={{ color: c.foregroundMuted }}>
            {kinds}
            {connector.selfHosted ? " on your own server" : ""}
          </Text>
        </View>
        {hostApi && !open && (
          <WorkButton
            theme={theme}
            label={`Connect ${connector.label}`}
            onPress={() => {
              setNotice(null);
              setOpen({ reconnect: null });
            }}
          >
            Connect
          </WorkButton>
        )}
      </View>
      {accounts.map((account) => {
        const s = STATE[account.state];
        return (
          <View
            key={account.id}
            testID={`integration-account-${account.id}`}
            style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderColor: c.border }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.foreground, fontWeight: "600", flexShrink: 1 }}>
                {account.displayName}
              </Text>
              <Text
                style={{
                  color: s.warn
                    ? (c.statusWarning ?? c.foreground)
                    : (c.statusSuccess ?? c.foregroundMuted),
                }}
              >
                {s.warn ? "⚠ " : "● "}
                {s.text}
              </Text>
            </View>
            {account.site && <Text style={{ color: c.foregroundMuted }}>{account.site}</Text>}
            {account.method === "cli" ? (
              // U7 W4: this Mac's own `gh` sign-in, listed by the host so Fulcra knows who you are. Nothing is stored to reconnect or disconnect.
              <Text style={{ color: c.foregroundMuted }}>
                From this Mac's GitHub sign-in. To change it, run gh auth login, or connect another
                GitHub account here.
              </Text>
            ) : account.state === "revoked" ? (
              <Text style={{ color: c.foregroundMuted }}>
                You disconnected this account, but its sign-in could not be removed from this
                computer's keychain. Fulcra no longer uses it. Try Disconnect again.
              </Text>
            ) : (
              s.warn && (
                <Text style={{ color: c.foregroundMuted }}>
                  Fulcra cannot read {connector.label} with this account until you reconnect it.
                </Text>
              )
            )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {account.method !== "cli" && (
                <>
                  {hostApi && account.state === "revoked" && (
                    <WorkButton
                      theme={theme}
                      label={`Retry disconnecting ${account.displayName}`}
                      selected
                      onPress={() => {
                        void remove(account);
                      }}
                    >
                      Retry disconnect
                    </WorkButton>
                  )}
                  {hostApi && account.state !== "revoked" && (
                    <WorkButton
                      theme={theme}
                      label={`Reconnect ${account.displayName}`}
                      selected={s.warn}
                      onPress={() => {
                        setNotice(null);
                        setOpen({ reconnect: account });
                      }}
                    >
                      Reconnect
                    </WorkButton>
                  )}
                  {hostApi &&
                    account.state !== "revoked" &&
                    (confirm === account.id ? (
                      <>
                        <WorkButton
                          theme={theme}
                          label={`Confirm disconnecting ${account.displayName}`}
                          onPress={() => {
                            void remove(account);
                          }}
                        >
                          Yes, disconnect
                        </WorkButton>
                        <WorkButton
                          theme={theme}
                          label="Keep it"
                          onPress={() => setConfirm(null)}
                        />
                      </>
                    ) : (
                      <WorkButton
                        theme={theme}
                        label={`Disconnect ${account.displayName}`}
                        onPress={() => setConfirm(account.id)}
                      >
                        Disconnect
                      </WorkButton>
                    ))}
                </>
              )}
            </View>
          </View>
        );
      })}
      {!accounts.length && (
        <Text style={{ color: c.foregroundMuted }}>
          No {connector.label} account connected yet.
        </Text>
      )}
      {open && credentials && (
        <ConnectForm
          theme={theme}
          connector={connector}
          credentials={credentials}
          reconnect={open.reconnect}
          onDone={(text) => {
            setOpen(null);
            setNotice(text);
            onChanged();
          }}
          onCancel={() => setOpen(null)}
        />
      )}
      {connector.auth.includes("cli") && (
        <Text style={{ color: c.foregroundMuted }}>
          Fulcra can also read {connector.label} through the command-line login on this computer.
          That login has broad access, so Fulcra only ever reads with it.
        </Text>
      )}
      {notice && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
          {notice}
        </Text>
      )}
    </View>
  );
}

function ConnectForm({
  theme,
  connector,
  credentials,
  reconnect,
  onDone,
  onCancel,
}: {
  theme: Theme;
  connector: Connector;
  credentials: Credentials;
  reconnect: Account | null;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const c = theme.colors,
    field = {
      color: c.foreground,
      padding: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface0,
    };
  const fields = tokenFields(connector);
  const [token, setToken] = useState(""),
    [site, setSite] = useState(reconnect?.site ?? ""),
    [email, setEmail] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const needsSite = !!fields.site && !reconnect,
    missing =
      !token.trim() ||
      (needsSite && !site.trim()) ||
      (fields.email === "required" && !email.trim());
  const [device, setDevice] = useState<Flow | null>(null);
  const flow = (method: string) =>
    reconnect
      ? credentials.reconnect({ accountId: reconnect.id, method })
      : credentials.begin({
          connector: connector.id,
          method,
          ...(fields.site ? { site: site.trim().toLowerCase() } : {}),
        });
  const withToken = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await flow("token");
      const r = await credentials.complete({
        flowId: f.flowId,
        input: {
          kind: "token",
          token: token.trim(),
          ...(fields.email && email.trim() ? { email: email.trim() } : {}),
        },
      });
      setToken("");
      setEmail("");
      onDone(
        r.status === "connected"
          ? `${r.account.displayName} is connected.`
          : "Still waiting for the tracker to confirm.",
      );
    } catch (e) {
      setToken("");
      setError(plain(e));
    } finally {
      setBusy(false);
    }
  };
  const withCode = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!device) {
        const f = await flow("device");
        setDevice(f);
        if (f.verifyUrl) openTrackerUrl(f.verifyUrl);
        return;
      }
      const r = await credentials.complete({ flowId: device.flowId, input: { kind: "poll" } });
      if (r.status === "pending") {
        setError(
          `${connector.label} has not confirmed yet. Try again in ${r.retryAfterSeconds} seconds.`,
        );
        return;
      }
      setDevice(null);
      onDone(`${r.account.displayName} is connected.`);
    } catch (e) {
      setDevice(null);
      setError(plain(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      testID={`integration-connect-${connector.id}`}
      style={{ gap: 10, paddingTop: 12, borderTopWidth: 1, borderColor: c.border }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>
        {reconnect ? `Reconnect ${reconnect.displayName}` : `Connect ${connector.label}`}
      </Text>
      {connector.auth.includes("device") && (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row" }}>
            <WorkButton
              theme={theme}
              label={
                device
                  ? `I have entered the code on ${connector.label}`
                  : `Sign in with a code on ${connector.label}`
              }
              disabled={busy}
              onPress={() => {
                void withCode();
              }}
            >
              {device ? "I have entered the code" : "Sign in with a code"}
            </WorkButton>
          </View>
          {device?.userCode && (
            <Text
              selectable
              style={{ color: c.foreground, fontSize: 20, fontWeight: "700", letterSpacing: 2 }}
            >
              {device.userCode}
            </Text>
          )}
          {device && (
            <Text style={{ color: c.foregroundMuted }}>
              Enter this code on the {connector.label} page that just opened, then come back here.
            </Text>
          )}
          <Text style={{ color: c.foregroundMuted }}>Or paste a token instead:</Text>
        </View>
      )}
      {needsSite && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.foreground }}>
            {connector.selfHosted ? "Your server's address" : `Your ${connector.label} site`}
          </Text>
          <TextInput
            placeholderTextColor={c.foregroundMuted}
            accessibilityLabel={
              connector.selfHosted ? `${connector.label} server address` : `${connector.label} site`
            }
            placeholder={fields.sitePlaceholder ?? "tracker.example.com"}
            autoCapitalize="none"
            autoCorrect={false}
            value={site}
            onChangeText={setSite}
            maxLength={253}
            style={field}
          />
        </View>
      )}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.foreground }}>1. Create a read-only token.</Text>
          <WorkButton
            theme={theme}
            label={`Create a ${connector.label} token (opens ${connector.label})`}
            onPress={() => {
              openHelpUrl(connector.tokenHelp.createUrl);
            }}
          >
            Create one ↗
          </WorkButton>
        </View>
        {connector.tokenHelp.scopes.length > 0 && (
          <Text style={{ color: c.foregroundMuted }}>Give it only these permissions:</Text>
        )}
        {connector.tokenHelp.scopes.map((scope) => (
          <Text key={scope} style={{ color: c.foregroundMuted }}>
            • {scope}
          </Text>
        ))}
        <Text style={{ color: c.foregroundMuted }}>{connector.tokenHelp.note}</Text>
      </View>
      <Text style={{ color: c.foreground }}>2. Paste it here.</Text>
      {fields.email && (
        <TextInput
          placeholderTextColor={c.foregroundMuted}
          accessibilityLabel={fields.emailLabel ?? "Email address"}
          placeholder={`${fields.emailLabel ?? "Email address"}${fields.email === "optional" ? " (optional)" : ""}`}
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
          maxLength={254}
          style={field}
        />
      )}
      <TextInput
        placeholderTextColor={c.foregroundMuted}
        accessibilityLabel={`${connector.label} token`}
        placeholder="Paste the token"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
        maxLength={512}
        style={field}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label={`Connect ${connector.label} with this token`}
          selected
          disabled={busy || missing}
          onPress={() => {
            void withToken();
          }}
        >
          {busy ? "Checking…" : "Connect"}
        </WorkButton>
        <WorkButton
          theme={theme}
          label="Cancel"
          onPress={() => {
            setToken("");
            setEmail("");
            onCancel();
          }}
        />
      </View>
      {error && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger ?? c.foreground }}>
          {error}
        </Text>
      )}
    </View>
  );
}

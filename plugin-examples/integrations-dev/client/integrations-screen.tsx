import { useCallback, useEffect, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  openExternalUrl,
  usePaseo,
  useRpc,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { checkAccount, sendTestNotification } from "../shared/checks";

type Paseo = ReturnType<typeof usePaseo>;
type Listing = Awaited<ReturnType<Paseo["credentials"]["list"]>>;
type Provider = Listing["providers"][number];
type Account = Listing["accounts"][number];

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TokenDraft {
  site: string;
  email: string;
  token: string;
}

function AccountRow({
  account,
  onReconnect,
  onChanged,
  report,
}: {
  account: Account;
  onReconnect(account: Account): void;
  onChanged(): void;
  report(text: string): void;
}) {
  const paseo = usePaseo();
  const check = useRpc(checkAccount);
  const runCheck = useCallback(() => {
    check({ accountId: account.id, connector: account.connector }).then(
      (facts) => report(`${facts.connector}: the provider answered ${facts.status}`),
      (error: unknown) => report(describe(error)),
    );
  }, [check, account, report]);
  const reconnect = useCallback(() => onReconnect(account), [onReconnect, account]);
  const disconnect = useCallback(() => {
    paseo.credentials
      .remove(account.id)
      .then(onChanged, (error: unknown) => report(describe(error)));
  }, [paseo, account, onChanged, report]);
  return (
    <SettingsRow label={account.displayName} hint={account.state}>
      <SettingsAction label="Check from the plugin server" actionLabel="Check" onPress={runCheck} />
      <SettingsAction
        label="Reconnect with the token below"
        actionLabel="Reconnect"
        onPress={reconnect}
      />
      <SettingsAction label="Disconnect" actionLabel="Disconnect" onPress={disconnect} />
    </SettingsRow>
  );
}

function ProviderSection({
  provider,
  allAccounts,
  onChanged,
  report,
}: {
  provider: Provider;
  allAccounts: Account[];
  onChanged(): void;
  report(text: string): void;
}) {
  const paseo = usePaseo();
  const [draft, setDraft] = useState<TokenDraft>({ site: "", email: "", token: "" });
  const [device, setDevice] = useState<{ flowId: string; userCode: string } | null>(null);
  const accounts = useMemo(
    () => allAccounts.filter((account) => account.connector === provider.connector),
    [allAccounts, provider],
  );
  const deviceAvailable = provider.methods.some(
    (entry) => entry.method === "device" && entry.status === "available",
  );
  const setSite = useCallback((site: string) => setDraft((current) => ({ ...current, site })), []);
  const setEmail = useCallback(
    (email: string) => setDraft((current) => ({ ...current, email })),
    [],
  );
  const setToken = useCallback(
    (token: string) => setDraft((current) => ({ ...current, token })),
    [],
  );

  // Connect (no account) or reconnect (account given) with a pasted token.
  const connectWithToken = useCallback(
    async (account: Account | null) => {
      try {
        const flow = account
          ? await paseo.credentials.reconnect({ accountId: account.id, method: "token" })
          : await paseo.credentials.begin({
              connector: provider.connector,
              method: "token",
              ...(provider.requiresSite ? { site: draft.site } : {}),
            });
        const result = await paseo.credentials.complete({
          flowId: flow.flowId,
          input: {
            kind: "token",
            token: draft.token,
            ...(draft.email ? { email: draft.email } : {}),
          },
        });
        report(
          result.status === "connected" ? `Connected ${result.account.displayName}` : "Pending",
        );
        onChanged();
      } catch (error) {
        report(describe(error));
      }
    },
    [paseo, provider, draft, onChanged, report],
  );
  const connect = useCallback(() => void connectWithToken(null), [connectWithToken]);
  const reconnect = useCallback(
    (account: Account) => void connectWithToken(account),
    [connectWithToken],
  );

  const deviceStep = useCallback(async () => {
    try {
      if (!device) {
        const flow = await paseo.credentials.begin({
          connector: provider.connector,
          method: "device",
        });
        setDevice({ flowId: flow.flowId, userCode: flow.userCode ?? "" });
        if (flow.verifyUrl) await openExternalUrl(flow.verifyUrl);
        return;
      }
      const result = await paseo.credentials.complete({
        flowId: device.flowId,
        input: { kind: "poll" },
      });
      if (result.status === "pending") {
        report(`Still waiting; try again in ${result.retryAfterSeconds} s`);
        return;
      }
      setDevice(null);
      report(`Connected ${result.account.displayName}`);
      onChanged();
    } catch (error) {
      setDevice(null);
      report(describe(error));
    }
  }, [paseo, provider, device, onChanged, report]);
  const pressDevice = useCallback(() => void deviceStep(), [deviceStep]);

  return (
    <SettingsSection title={provider.label}>
      <SettingsCard>
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            onReconnect={reconnect}
            onChanged={onChanged}
            report={report}
          />
        ))}
        {provider.requiresSite ? (
          <SettingsInput label="Site" placeholder="acme.atlassian.net" onChangeText={setSite} />
        ) : null}
        {provider.requiresEmailForToken ? (
          <SettingsInput label="Account email" onChangeText={setEmail} />
        ) : null}
        {provider.acceptsUsernameForToken ? (
          <SettingsInput label="Username (personal tokens)" onChangeText={setEmail} />
        ) : null}
        <SettingsInput
          label="Token"
          hint={provider.tokenHelp.note}
          secureTextEntry
          onChangeText={setToken}
        />
        <SettingsAction label="Connect with this token" actionLabel="Connect" onPress={connect} />
        {deviceAvailable ? (
          <SettingsAction
            label={
              device
                ? `Enter code ${device.userCode} on the provider's page`
                : "Sign in with a code"
            }
            actionLabel={device ? "Finish" : "Start"}
            onPress={pressDevice}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

// Developer test screen only: the product Settings › Integrations UI is separate work.
export function IntegrationsScreen({ theme }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const notify = useRpc(sendTestNotification);
  const [listing, setListing] = useState<Listing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);

  const refresh = useCallback(() => {
    paseo.credentials.list().then(setListing, (error: unknown) => setMessage(describe(error)));
  }, [paseo]);
  useEffect(refresh, [refresh]);
  const sendPush = useCallback(() => {
    notify({ urgency: "now" }).then(
      () => setMessage("Sent"),
      (error: unknown) => setMessage(describe(error)),
    );
  }, [notify]);

  return (
    <>
      {message ? <Text style={textStyle}>{message}</Text> : null}
      <SettingsSection title="Notifications">
        <SettingsCard>
          <SettingsAction label="Send a push (urgency now)" actionLabel="Send" onPress={sendPush} />
        </SettingsCard>
      </SettingsSection>
      {listing?.providers.map((provider) => (
        <ProviderSection
          key={provider.connector}
          provider={provider}
          allAccounts={listing.accounts}
          onChanged={refresh}
          report={setMessage}
        />
      ))}
    </>
  );
}

import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import {
  channelsRpc,
  channelPairOpenRpc,
  channelPauseRpc,
  channelRevokeRpc,
  channelKindName,
  channelAnswerText,
  type Channel,
} from "../shared/cc/channels";

/**
 * Settings › Channels (CONTRACTS v1.6 §3.5, D4): use the inbox from anywhere. Each channel is a view of the same inbox
 * that can answer; the controller decides what counts. Pairing starts here with a 6-digit code. Pause stops a channel
 * showing or answering; Revoke ends it for good.
 */
type Theme = PluginSurfaceProps["theme"];
const DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const ALL = { projects: "all" as const, canAnswer: true, levels: [1, 2, 3] as (1 | 2 | 3)[] };
const PAIR: { kind: Channel["kind"]; label: string; how: string }[] = [
  {
    kind: "discord-openclaw",
    label: "Discord",
    how: "Type this code in your Fulcra Discord conversation.",
  },
  { kind: "cli", label: "Terminal", how: "Run: fulcra inbox pair <code>" },
  {
    kind: "session",
    label: "Claude or Codex session",
    how: "Ask the session to pair the Fulcra inbox with this code.",
  },
];
function Button({
  theme,
  label,
  onPress,
  testID,
  danger,
  disabled,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  testID?: string;
  danger?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: 16,
        justifyContent: "center",
        borderRadius: 12,
        borderWidth: danger ? 0 : 1,
        borderColor: c.border,
        backgroundColor: danger ? c.statusDanger : c.surface1,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: danger ? c.accentForeground : c.foreground, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}
export function ChannelsSurface({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const read = useContract(channelsRpc),
    open = useContract(channelPairOpenRpc),
    pause = useContract(channelPauseRpc),
    revoke = useContract(channelRevokeRpc),
    c = theme.colors;
  const query = useQuery({
    queryKey: ["orca-organization", "channels"],
    queryFn: () => read({}),
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const [code, setCode] = useState<{
    kind: string;
    code: string;
    expiresAt: string;
    how: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null),
    [confirmRevoke, setConfirmRevoke] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<{ ok: boolean; message: string | null }>, done: string) => {
    setBusy(true);
    try {
      const r = await run();
      setNotice(r.ok ? done : (r.message ?? "Refused"));
      if (r.ok) void query.refetch();
    } catch {
      setNotice("Connection unavailable; nothing was confirmed. Refresh to check.");
    } finally {
      setBusy(false);
    }
  };
  const box = (key: string, children: ReactNode) => (
    <View
      key={key}
      style={{
        gap: 6,
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
  const channels = (query.data?.channels ?? []).filter((x) => x.state !== "revoked");
  return (
    <ScrollView
      testID="channels-list"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 12 : 24,
        gap: 16,
        maxWidth: 760,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ gap: 4 }}>
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 26, fontWeight: "700" }}
        >
          Channels
        </Text>
        <Text style={{ color: c.foregroundMuted }}>
          Use your inbox from Discord, a terminal or a Claude or Codex session. Answer in one place
          and every other copy says it was answered.
        </Text>
        {/* A plugin can only open its own settings pages, so this names the desktop setting in words. */}
        <Text style={{ color: c.foregroundMuted }}>
          To get one alert for several finished sessions on this computer, turn on Group finished
          sessions in Settings › Notifications in the desktop app.
        </Text>
      </View>
      {query.data?.stale && (
        <Text style={{ color: c.statusWarning }}>May be out of date. {query.data.error}</Text>
      )}
      {notice && (
        <View
          accessibilityLiveRegion="polite"
          style={{ padding: 10, borderRadius: 8, backgroundColor: c.surface2 }}
        >
          <Text style={{ color: c.foreground }}>{notice}</Text>
        </View>
      )}
      {box(
        "pair",
        <>
          <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
            Pair a channel
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PAIR.map((p) => (
              <Button
                key={p.kind}
                testID={`channel-pair-${p.kind}`}
                theme={theme}
                label={p.label}
                disabled={busy}
                onPress={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const r = await open({ kind: p.kind, label: p.label, scope: ALL });
                      if (r.ok && r.code && r.expiresAt) {
                        setCode({
                          kind: p.label,
                          code: r.code,
                          expiresAt: r.expiresAt,
                          how: p.how,
                        });
                        setNotice(null);
                      } else setNotice(r.message ?? "Refused");
                    } catch {
                      setNotice("Connection unavailable; no code was made.");
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              />
            ))}
          </View>
          {code && (
            <View
              testID="channel-code"
              style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.surface2 }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
                {code.kind.toUpperCase()} CODE · works once, until{" "}
                {new Date(code.expiresAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
              <Text
                selectable
                style={{ color: c.foreground, fontSize: 32, fontWeight: "700", letterSpacing: 6 }}
              >
                {code.code}
              </Text>
              <Text style={{ color: c.foreground }}>{code.how}</Text>
            </View>
          )}
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            Answers from Discord count as yours only when you pair from a device you have confirmed.
            Device pairing isn't available in this version of Fulcra yet, so for now, and always
            from a terminal or session, answers are marked as answered by the operator, and
            approvals that start work wait for a paired device.
          </Text>
        </>,
      )}
      {!query.data && (
        <Text style={{ color: c.foregroundMuted }}>
          {query.isPending ? "Checking your channels…" : "Your channels could not be read."}
        </Text>
      )}
      {query.data && !channels.length && (
        <Text style={{ color: c.foregroundMuted }}>No channels yet. Pair one above.</Text>
      )}
      {channels.map((x) =>
        box(
          x.id,
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.foreground, fontWeight: "700", fontSize: 16 }}>
                {x.label}
              </Text>
              <Text
                style={{
                  color: x.state === "active" ? c.statusSuccess : c.statusWarning,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {x.state === "active" ? "On" : "Paused"}
              </Text>
            </View>
            <Text style={{ color: c.foreground }}>
              {channelKindName(x.kind)} · {channelAnswerText(x)}
            </Text>
            <Text style={{ color: c.foregroundMuted }}>
              Paired {new Date(x.pairedAt).toLocaleDateString(undefined, DATE)}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button
                testID={`channel-pause-${x.id}`}
                theme={theme}
                disabled={busy}
                label={x.state === "active" ? "Pause" : "Turn back on"}
                onPress={() => {
                  void act(
                    () =>
                      pause({
                        id: x.id,
                        expectedRevision: x.revision,
                        paused: x.state === "active",
                      }),
                    x.state === "active" ? `${x.label} is paused.` : `${x.label} is on again.`,
                  );
                }}
              />
              {confirmRevoke === x.id ? (
                <Button
                  testID={`channel-revoke-${x.id}`}
                  theme={theme}
                  danger
                  disabled={busy}
                  label={`Yes, revoke ${x.label}`}
                  onPress={() => {
                    setConfirmRevoke(null);
                    void act(
                      () => revoke({ id: x.id, expectedRevision: x.revision }),
                      `${x.label} is revoked.`,
                    );
                  }}
                />
              ) : (
                <Button
                  testID={`channel-revoke-${x.id}`}
                  theme={theme}
                  disabled={busy}
                  label="Revoke"
                  onPress={() => setConfirmRevoke(x.id)}
                />
              )}
            </View>
          </>,
        ),
      )}
    </ScrollView>
  );
}

// Fresh start in the UI: a confirmed button for a main assistant or project lead, and the plain history line
// ("Fresh start at 14:02 · handoff"). Both read the same recovery status the Recovery panel polls.
import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { randomId } from "./random-id";
import { recoveryActionRpc, recoveryRpc } from "../shared/recovery";
import { freshStartLine, freshStartSupported, freshStartsFor } from "./fresh-start";

type Theme = PluginSurfaceProps["theme"];

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function useRecoveryStatus(hostId: string | undefined) {
  const read = useContract(recoveryRpc);
  const query = useQuery({
    queryKey: ["orca-recovery", hostId],
    queryFn: () => read({}),
    staleTime: 10000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return query.data?.status === "observed" ? query.data.recovery : undefined;
}

export function FreshStartButton({
  sessionId,
  theme,
  hostId,
}: {
  sessionId: string;
  theme: Theme;
  hostId: string | undefined;
}) {
  const recovery = useRecoveryStatus(hostId);
  const act = useContract(recoveryActionRpc);
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (!freshStartSupported(recovery)) return null;
  const c = theme.colors;
  const start = async () => {
    setBusy(true);
    try {
      const reply = (await act({
        action: "fresh-start",
        messageId: randomId(),
        sessionId,
        reason: "Fresh start requested by you from Fulcra",
      })) as { message?: string };
      setNotice(reply.message ?? "Sent.");
    } catch {
      setNotice("Fresh start could not be sent. Try again in a moment.");
    } finally {
      setBusy(false);
      setConfirming(false);
      void client.invalidateQueries({ queryKey: ["orca-recovery", hostId] });
    }
  };
  return (
    <View testID="fresh-start" style={{ gap: 6 }}>
      {confirming ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground }}>
            Start fresh? Fulcra saves a handoff, then this chat carries on in a new context with the
            same name, role and team.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <WorkButton
              theme={theme}
              label="Start fresh now"
              disabled={busy}
              onPress={() => void start()}
            />
            <WorkButton theme={theme} label="Cancel" onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row" }}>
          <WorkButton theme={theme} label="Fresh start" onPress={() => setConfirming(true)} />
        </View>
      )}
      {notice && (
        <Text testID="fresh-start-notice" style={{ color: c.foregroundMuted }}>
          {notice}
        </Text>
      )}
    </View>
  );
}

export function FreshStartHistory({
  sessionId,
  theme,
  hostId,
  formatTime = clock,
}: {
  sessionId: string;
  theme: Theme;
  hostId: string | undefined;
  formatTime?: (at: number) => string;
}) {
  const recovery = useRecoveryStatus(hostId);
  const starts = freshStartsFor(recovery, sessionId);
  if (!starts.length) return null;
  return (
    <View testID="fresh-start-history" style={{ gap: 2 }}>
      {starts.slice(0, 5).map((start) => (
        <Text
          key={start.id}
          style={{
            color:
              start.state === "rotated" ? theme.colors.foregroundMuted : theme.colors.statusWarning,
          }}
        >
          {freshStartLine(start, formatTime)}
        </Text>
      ))}
    </View>
  );
}

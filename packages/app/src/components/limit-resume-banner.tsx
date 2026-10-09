import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  LIMIT_RESUME_PROMPT,
  INTERRUPTED_RESUME_PROMPT,
  NETWORK_RESUME_PROMPT,
  LIMIT_RESUME_REASON_LABEL,
  pendingLimitResumeAt,
} from "@getpaseo/protocol/limit-resume";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";

const RESUME_PROMPTS: Partial<Record<string, string>> = {
  network: NETWORK_RESUME_PROMPT,
  interrupted: INTERRUPTED_RESUME_PROMPT,
};

// Matches the chat column width the banner sits above.
const MAX_CONTENT_WIDTH = 820;

export function formatLimitResumeStatus(resumeAtMs: number, reason = "usage"): string {
  const time = new Date(resumeAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (reason === "network") return `Paused: network, retrying at ${time}`;
  if (reason === "interrupted") return `Paused: interrupted by a restart, resumes at ${time}`;
  return `Paused: usage limit, resumes at ${time}`;
}

/** Shown above the composer while the host has a resume queued for this session. */
export function LimitResumeBanner({ serverId, agentId }: { serverId: string; agentId: string }) {
  const client = useHostRuntimeClient(serverId);
  const labelAt = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents?.get(agentId)?.labels?.[LIMIT_RESUME_AT_LABEL] ?? "",
  );
  const reason = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents?.get(agentId)?.labels?.[LIMIT_RESUME_REASON_LABEL] ??
      "usage",
  );
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!labelAt) return undefined;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [labelAt]);

  const resumeAt = pendingLimitResumeAt({ [LIMIT_RESUME_AT_LABEL]: labelAt }, nowMs);

  // The host cancels the queued resume as soon as this turn starts.
  const handleResumeNow = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      await client.sendAgentMessage(agentId, RESUME_PROMPTS[reason] ?? LIMIT_RESUME_PROMPT);
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [client, agentId, reason]);

  const handleOptOut = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      await client.updateAgent(agentId, {
        labels: { [LIMIT_RESUME_OPT_OUT_LABEL]: "off", [LIMIT_RESUME_AT_LABEL]: "" },
      });
    } catch (e) {
      setError(toErrorMessage(e));
    }
  }, [client, agentId]);

  if (resumeAt === null) return null;

  return (
    <View style={styles.container} testID="limit-resume-banner">
      <View style={styles.content}>
        <Text style={styles.text}>{formatLimitResumeStatus(resumeAt, reason)}</Text>
        <View style={styles.actions}>
          <Button size="sm" variant="secondary" onPress={handleResumeNow} testID="limit-resume-now">
            Resume now
          </Button>
          <Button size="sm" variant="ghost" onPress={handleOptOut} testID="limit-resume-opt-out">
            {"Don't auto-resume"}
          </Button>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  content: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
}));

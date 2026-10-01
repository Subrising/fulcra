import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useFetchQuery } from "@/data/query";
import { EditingTextInput } from "@/components/ui/text-input";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Button } from "@/components/ui/button";
import { useContract } from "../../../../../control/orca-organization/client/use-contract";
import {
  intercomRateSettingsGetRpc,
  intercomRateSettingsRpc,
  intercomStatusRpc,
} from "../../../../../control/orca-organization/shared/intercom";
import { IntercomRateSettingsSchema } from "@getpaseo/protocol/native-intercom";

import { ReportHierarchyControls } from "./report-hierarchy-controls";

const LIMITS = { report: 12, followup: 64, channel: 64, seat: 32 } as const;
type Purpose = keyof typeof LIMITS;
type Draft = Record<Purpose, string>;
const EMPTY: Draft = { report: "0", followup: "0", channel: "0", seat: "0" };
const LABELS: Record<Purpose, string> = {
  report: "Reports",
  followup: "Follow-ups",
  channel: "Channel messages",
  seat: "Seat reservations",
};
const safeFailure = (error: unknown) =>
  error instanceof Error && /owner|permission|denied|forbidden/i.test(error.message)
    ? "Owner required. Sign in with this host’s owner connection to manage intercom."
    : "Intercom could not be read or saved. Refresh owner settings before making another change. No defaults were activated.";

export function IntercomSettingsSection({ theme, host }: PluginHostProps) {
  const read = useContract(intercomRateSettingsGetRpc);
  const save = useContract(intercomRateSettingsRpc);
  const status = useContract(intercomStatusRpc);
  const c = theme.colors;
  const styles = useMemo(
    () => ({
      root: { gap: 14 },
      field: { gap: 4 },
      text: { color: c.foreground },
      muted: { color: c.foregroundMuted },
      title: { color: c.foreground, fontSize: 20, fontWeight: "700" as const },
      input: { color: c.foreground, borderColor: c.border, borderWidth: 1, padding: 8 },
    }),
    [c],
  );
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryKey: ["intercom", "owner-settings", host.id],
    queryFn: () => read({}),
    retry: false,
  });
  const { refetch } = query;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const statusGeneration = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      statusGeneration.current++;
    },
    [],
  );
  useEffect(() => {
    if (query.data?.settings)
      setDraft(
        Object.fromEntries(
          Object.entries(query.data.settings).map(([key, value]) => [key, String(value)]),
        ) as Draft,
      );
  }, [query.data]);
  const parsed = useMemo(
    () =>
      Object.values(draft).every((value) => /^\d+$/.test(value))
        ? IntercomRateSettingsSchema.safeParse(
            Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, Number(value)])),
          )
        : null,
    [draft],
  );
  const onSave = useCallback(async () => {
    if (!parsed?.success || busy || !query.data || query.error) return;
    const current = generation.current;
    setBusy(true);
    setNotice(null);
    try {
      await save({ messageId: globalThis.crypto.randomUUID(), settings: parsed.data });
      if (generation.current !== current) return;
      await refetch();
      if (generation.current === current) setNotice("Limits saved for this host.");
    } catch (error) {
      if (generation.current === current) setNotice(safeFailure(error));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [parsed, busy, query.data, query.error, refetch, save]);
  const readAgent = useCallback(async () => {
    const current = ++statusGeneration.current;
    setAgentNotice("Reading current session capability…");
    try {
      const result = await status({ agentId });
      if (statusGeneration.current !== current) return;
      setAgentNotice(
        !result.identity
          ? "Current native identity unavailable. No registration or adoption was performed."
          : `Codex native manager boundary: ${result.queueAvailable ? "available" : "unavailable"}. Public message-path admission is separate. Report link: ${result.reportLinked ? "verified" : "not registered"}. Settings: ${result.settingsInitialized ? "initialized" : "not initialized"}.`,
      );
    } catch (error) {
      if (statusGeneration.current === current) setAgentNotice(safeFailure(error));
    }
  }, [agentId, status]);
  const changeAgent = useCallback((value: string) => {
    statusGeneration.current++;
    setAgentId(value);
    setAgentNotice(null);
  }, []);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const fieldCallbacks = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(LIMITS) as Purpose[]).map((key) => [
          key,
          (value: string) => setDraft((old) => ({ ...old, [key]: value })),
        ]),
      ) as Record<Purpose, (value: string) => void>,
    [],
  );
  return (
    <View style={styles.root} testID="intercom-settings">
      <Text accessibilityRole="header" style={styles.title}>
        Intercom
      </Text>
      <Text style={styles.muted}>
        Owner-only limits for this host. Each limit applies over a rolling hour; zero disables that
        purpose. Saving does not renew grants or expand concurrency.
      </Text>
      <Text style={styles.muted}>
        The native manager boundary supports Codex only; public message-path admission is separate.
        Claude queued delivery is unsupported. A queued message is not a provider acceptance or a
        consumed report.
      </Text>
      {query.isPending && <Text style={styles.muted}>Reading owner settings…</Text>}
      {query.error && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {safeFailure(query.error)}
        </Text>
      )}
      {query.data && !query.error && (
        <>
          <Text style={styles.text}>
            {query.data.initialized
              ? "Saved limits are active."
              : "Intercom settings are not initialized. The values below are inactive until you explicitly save."}
          </Text>
          {(Object.keys(LIMITS) as Purpose[]).map((key) => (
            <View key={key} style={styles.field}>
              <Text style={styles.text}>
                {LABELS[key]} per hour (0–{LIMITS[key]})
              </Text>
              <EditingTextInput
                accessibilityLabel={`${LABELS[key]} per hour`}
                keyboardType="number-pad"
                editable={!busy}
                key={`${key}:${query.dataUpdatedAt}`}
                initialValue={String(query.data.settings?.[key] ?? 0)}
                onChangeText={fieldCallbacks[key]}
                style={styles.input}
              />
            </View>
          ))}
          {!parsed?.success && (
            <Text style={styles.muted}>Enter a whole number within each stated limit.</Text>
          )}
          <Button onPress={onSave} disabled={busy || !parsed?.success}>
            {busy ? "Saving…" : "Save limits"}
          </Button>
          <Text style={styles.muted}>
            Inspect a session using its exact session ID. This read does not register a prime, adopt
            a parent or grant report rights.
          </Text>
          <EditingTextInput
            accessibilityLabel="Session ID for intercom status"
            initialValue=""
            onChangeText={changeAgent}
            style={styles.input}
          />
          <Button
            variant="outline"
            onPress={readAgent}
            disabled={
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
            }
          >
            Read session capability
          </Button>
        </>
      )}
      <ReportHierarchyControls key={host.id} hostId={host.id} colors={c} />
      {notice && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {notice}
        </Text>
      )}
      {agentNotice && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {agentNotice}
        </Text>
      )}
      <Button variant="outline" disabled={busy} onPress={refresh}>
        Refresh owner settings
      </Button>
    </View>
  );
}

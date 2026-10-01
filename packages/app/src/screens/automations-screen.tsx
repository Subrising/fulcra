import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Automation, AutomationResult, AutomationRun } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AutomationFormSheet } from "@/components/automations/automation-form-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useFetchQuery } from "@/data/query";
import {
  describeAction,
  describeRunSource,
  describeTrigger,
  type AutomationNames,
} from "@/automations/describe";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// Automations (GitKraken Automations): "When X, do Y" on top of this host's schedules. A list with on/off, last run
// and run history, and a builder sheet. Nothing is posted outside Fulcra unless an automation opts in.

const K = "automations";
const HISTORY_SHOWN = 20;
const RUN_BADGE = { ok: "success", failed: "error", skipped: "muted", running: "warning" } as const;

type Payload = Awaited<ReturnType<DaemonClient["listAutomations"]>>;
type SheetState = { mode: "create" } | { mode: "edit"; automation: Automation } | null;

export function AutomationsScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.root} />;
  return <AutomationsContent />;
}

function useNames(result: AutomationResult | null): AutomationNames {
  return useMemo(() => {
    const projects = new Map(result?.projects.map((p) => [p.projectId, p.name]) ?? []);
    const sessions = new Map(result?.sessions.map((s) => [s.agentId, s.title]) ?? []);
    const templates = new Map(result?.templates.map((p) => [p.id, p.name]) ?? []);
    return {
      project: (id) => projects.get(id),
      session: (id) => sessions.get(id),
      template: (id) => templates.get(id),
    };
  }, [result]);
}

function hasRunning(result: AutomationResult | null): boolean {
  return Boolean(result?.automations.some((a) => a.runs.some((r) => r.status === "running")));
}

function AutomationsContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const client = useSessionStore(
    (state) => (serverId ? state.sessions[serverId]?.client : null) ?? null,
  );
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["automations", serverId], [serverId]);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 5_000,
    queryKey,
    enabled: Boolean(client),
    retry: false,
    refetchInterval: (q) =>
      hasRunning(q.state.data?.status === "ok" ? (q.state.data.result ?? null) : null)
        ? 5_000
        : 30_000,
    queryFn: async () => {
      if (!client) throw new Error("No host");
      return client.listAutomations();
    },
  });
  const result = query.data?.status === "ok" ? (query.data.result ?? null) : null;
  const names = useNames(result);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (work: () => Promise<Payload>) => {
      setError(null);
      const payload = await work();
      if (payload.status === "ok") queryClient.setQueryData(queryKey, payload);
      else setError(payload.error ?? t(`${K}.failed`));
      return payload;
    },
    [queryClient, queryKey, t],
  );
  const openCreate = useCallback(() => setSheet({ mode: "create" }), []);
  const openEdit = useCallback(
    (automation: Automation) => setSheet({ mode: "edit", automation }),
    [],
  );
  const closeSheet = useCallback(() => setSheet(null), []);

  let body: ReactElement;
  if (query.isLoading) body = <Text style={styles.muted}>{t(`${K}.loading`)}</Text>;
  else if (!result || !client) body = <Text style={styles.muted}>{t(`${K}.failed`)}</Text>;
  else if (result.automations.length === 0)
    body = <Text style={styles.muted}>{t(`${K}.empty`)}</Text>;
  else
    body = (
      <View style={styles.list}>
        {result.automations.map((automation) => (
          <AutomationCard
            key={automation.id}
            automation={automation}
            names={names}
            client={client}
            apply={apply}
            onEdit={openEdit}
          />
        ))}
      </View>
    );

  return (
    <View style={styles.root} testID="automations-screen">
      <MenuHeader title={t(`${K}.title`)} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.intro}>
          <Text style={styles.introText}>{t(`${K}.intro`)}</Text>
          <Button
            variant="default"
            size="sm"
            onPress={openCreate}
            disabled={!result}
            testID="automations-new"
          >
            {t(`${K}.new`)}
          </Button>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {body}
      </ScrollView>
      {sheet && client && result ? (
        <AutomationFormSheet
          key={sheet.mode === "edit" ? sheet.automation.id : "create"}
          automation={sheet.mode === "edit" ? sheet.automation : undefined}
          result={result}
          names={names}
          client={client}
          apply={apply}
          onClose={closeSheet}
        />
      ) : null}
    </View>
  );
}

interface CardProps {
  automation: Automation;
  names: AutomationNames;
  client: DaemonClient;
  apply: (work: () => Promise<Payload>) => Promise<Payload>;
  onEdit: (automation: Automation) => void;
}

function AutomationCard({ automation, names, client, apply, onEdit }: CardProps) {
  const { t } = useTranslation();
  const [showHistory, setShowHistory] = useState(false);
  const [running, setRunning] = useState(false);
  const { id } = automation;
  const toggle = useCallback(
    (enabled: boolean) => void apply(() => client.setAutomationEnabled({ id, enabled })),
    [apply, client, id],
  );
  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      await apply(() => client.runAutomationNow(id));
    } finally {
      setRunning(false);
    }
  }, [apply, client, id]);
  const edit = useCallback(() => onEdit(automation), [automation, onEdit]);
  const flipHistory = useCallback(() => setShowHistory((v) => !v), []);
  const last = automation.runs[automation.runs.length - 1];
  return (
    <View style={styles.card} testID={`automation-${automation.id}`}>
      <View style={styles.cardHead}>
        <View style={styles.cardTitleBox}>
          <Text style={styles.cardTitle}>{automation.name}</Text>
          <Text style={styles.sentence}>
            {describeTrigger(t, automation.trigger, names)}
            {", "}
            {describeAction(t, automation.action, names)}
          </Text>
        </View>
        <Switch
          value={automation.enabled}
          onValueChange={toggle}
          accessibilityLabel={t(`${K}.enabled`)}
          testID="automation-enabled"
        />
      </View>
      <LastRun automation={automation} run={last} />
      <View style={styles.actions}>
        <Button size="sm" variant="secondary" onPress={runNow} loading={running}>
          {t(`${K}.runNow`)}
        </Button>
        <Button size="sm" variant="ghost" onPress={flipHistory} testID="automation-history">
          {t(showHistory ? `${K}.hideHistory` : `${K}.history`, { count: automation.runs.length })}
        </Button>
        <Button size="sm" variant="ghost" onPress={edit}>
          {t(`${K}.edit`)}
        </Button>
      </View>
      {showHistory ? <History automation={automation} /> : null}
    </View>
  );
}

function when(iso: string, language: string): string {
  return new Date(iso).toLocaleString(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LastRun(props: { automation: Automation; run: AutomationRun | undefined }) {
  const { t, i18n } = useTranslation();
  const { run } = props;
  if (!run) return <Text style={styles.muted}>{t(`${K}.neverRun`)}</Text>;
  return (
    <View style={styles.lastRun}>
      <Text style={styles.muted}>
        {t(`${K}.lastRun`, {
          when: when(run.at, i18n.language),
          source: describeRunSource(t, run, props.automation),
        })}
      </Text>
      <StatusBadge label={t(`${K}.status.${run.status}`)} variant={RUN_BADGE[run.status]} />
    </View>
  );
}

function History(props: { automation: Automation }) {
  const { t, i18n } = useTranslation();
  const runs = useMemo(
    () =>
      [...props.automation.runs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, HISTORY_SHOWN),
    [props.automation.runs],
  );
  const skipped = props.automation.skipped;
  const skippedLine = skipped ? (
    <Text style={styles.muted}>
      {t(`${K}.skippedSummary`, {
        count: skipped.count,
        when: when(skipped.lastAt, i18n.language),
      })}
    </Text>
  ) : null;
  if (runs.length === 0) {
    return (
      <View style={styles.history}>
        <Text style={styles.muted}>{t(`${K}.noRuns`)}</Text>
        {skippedLine}
      </View>
    );
  }
  return (
    <View style={styles.history} testID="automation-history-list">
      {skippedLine}
      {runs.map((run) => (
        <View key={run.id} style={styles.historyRow}>
          <Text style={styles.historyWhen}>{when(run.at, i18n.language)}</Text>
          <View style={styles.historyBody}>
            <Text style={styles.note}>{describeRunSource(t, run, props.automation)}</Text>
            {run.detail ? (
              <Text style={styles.muted} numberOfLines={2}>
                {run.detail}
              </Text>
            ) : null}
          </View>
          <StatusBadge label={t(`${K}.status.${run.status}`)} variant={RUN_BADGE[run.status]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    maxWidth: 900,
    width: "100%",
    alignSelf: "center",
  },
  intro: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  introText: {
    flexShrink: 1,
    flexBasis: 280,
    flexGrow: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  list: { gap: theme.spacing[3] },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  cardTitleBox: { flex: 1, gap: theme.spacing[1] },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  sentence: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  lastRun: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  note: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  history: {
    gap: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  historyWhen: {
    width: 110,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  historyBody: { flex: 1, gap: theme.spacing[0.5] },
}));

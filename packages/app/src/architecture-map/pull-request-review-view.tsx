import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  CheckoutPullRequestReviewGetResponse,
  PullRequestReviewDecisionKind,
} from "@getpaseo/protocol/messages";
import { EditingTextInput } from "@/components/ui/text-input";
import { Switch } from "@/components/ui/switch";
import { DiffDocument } from "@/git/diff-document";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import {
  usePullRequestReview,
  useReviewExplanation,
  useReviewFileDiff,
} from "./use-generated-change";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { recordReviewInInbox } from "./review-inbox";
import { groupReviewFiles, plainFileKey, startHerePath } from "./review-file-order";
import { beforeYouApprove, FLAG_LABEL, reviewFlags, type ReviewFlag } from "./review-flags";

// The PR review screen (Code Review): the changed files grouped by module with size and risk, one file's diff with
// the automated review's findings beside it, the pull request's summary and the ADW verdict, and a decision bar.
// The decision is recorded in Fulcra; it reaches GitHub only when "Also post to GitHub" is ticked.

const K = "panels.architectureMap.review";
const WIDE = 900;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
const COMMIT_MODE = { kind: "commit" as const };
const AUTO_SUMMARY_LIMIT = 30;

type Payload = CheckoutPullRequestReviewGetResponse["payload"];
type ReviewFile = NonNullable<Payload["files"]>[number];
type Finding = NonNullable<Payload["adw"]>["findings"][number];
type Decision = NonNullable<Payload["decision"]>;

const DECISIONS: readonly PullRequestReviewDecisionKind[] = [
  "approve",
  "request_changes",
  "comment",
];
const DECISION_KEY: Record<PullRequestReviewDecisionKind, string> = {
  approve: "approve",
  request_changes: "requestChanges",
  comment: "comment",
};

export interface PullRequestReviewViewProps {
  serverId: string;
  cwd: string;
  pullRequest: number;
  onBack: () => void;
  onShowInMap: ((pullRequest: number) => void) | null;
}

export function PullRequestReviewView(props: PullRequestReviewViewProps) {
  const { t } = useTranslation();
  const query = usePullRequestReview({
    serverId: props.serverId,
    cwd: props.cwd,
    pullRequest: props.pullRequest,
  });
  const payload = query.data ?? null;
  if (query.isLoading) return <Centered text={t(`${K}.loading`)} />;
  if (query.error || !payload || payload.status !== "ok" || !payload.files) {
    return (
      <Centered
        text={t(`${K}.failed`)}
        detail={payload?.error ?? (query.error instanceof Error ? query.error.message : null)}
      />
    );
  }
  return <ReviewReady {...props} payload={payload} files={payload.files} />;
}

function ReviewReady(
  props: PullRequestReviewViewProps & { payload: Payload; files: ReviewFile[] },
) {
  const { payload, files } = props;
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  const firstPath = useMemo(
    () => startHerePath(files) ?? groupReviewFiles(files)[0]?.[1][0]?.path ?? null,
    [files],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = chosen ?? firstPath;
  const [recorded, setRecorded] = useState<Decision | null>(payload.decision ?? null);
  // Each file's flags, recorded as its diff is opened; the checklist counts only what has been looked at.
  const [flagsByPath, setFlagsByPath] = useState<ReadonlyMap<string, readonly ReviewFlag[]>>(
    () => new Map(),
  );
  const onFlags = useCallback((path: string, flags: readonly ReviewFlag[]) => {
    setFlagsByPath((prev) => {
      const old = prev.get(path);
      // Compared by value: a re-read diff yields equal flags in new objects, and must not re-render forever.
      if (old && sameFlags(old, flags)) return prev;
      return new Map(prev).set(path, flags);
    });
  }, []);
  // Summaries are asked for automatically on the first 30 files opened in this review; after that, on request.
  const [autoExplained, setAutoExplained] = useState<ReadonlySet<string>>(() => new Set());
  const autoSummary =
    selected !== null && (autoExplained.has(selected) || autoExplained.size < AUTO_SUMMARY_LIMIT);
  useEffect(() => {
    if (selected && autoSummary && !autoExplained.has(selected))
      setAutoExplained((prev) => new Set(prev).add(selected));
  }, [autoExplained, autoSummary, selected]);
  const wide = width >= WIDE;
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      onLayout={onLayout}
      testID="pull-request-review"
    >
      <ReviewHeader payload={payload} onBack={props.onBack} onShowInMap={props.onShowInMap} />
      <View style={wide ? styles.columns : styles.stack}>
        <View style={wide ? styles.sidebar : styles.full}>
          <FileList files={files} selected={selected} onSelect={setChosen} />
        </View>
        <View style={styles.main}>
          <FilePane
            serverId={props.serverId}
            cwd={props.cwd}
            payload={payload}
            path={selected}
            file={files.find((f) => f.path === selected) ?? null}
            onFlags={onFlags}
            autoSummary={autoSummary}
          />
        </View>
      </View>
      <BeforeYouApprove files={files} flagsByPath={flagsByPath} />
      <DecisionBar
        serverId={props.serverId}
        cwd={props.cwd}
        pullRequest={props.pullRequest}
        headOid={payload.head ?? ""}
        url={payload.pullRequest?.url}
        recorded={recorded}
        onRecorded={setRecorded}
      />
    </ScrollView>
  );
}

function ReviewHeader(props: {
  payload: Payload;
  onBack: () => void;
  onShowInMap: ((pullRequest: number) => void) | null;
}) {
  const { t } = useTranslation();
  const { payload, onShowInMap } = props;
  const pr = payload.pullRequest;
  const number = pr?.number ?? 0;
  const showInMap = useCallback(() => onShowInMap?.(number), [onShowInMap, number]);
  const checks = payload.checks ?? { status: "none" as const, items: [] };
  const passed = checks.items.filter((c) => /success|pass|neutral|skipped/.test(c.status)).length;
  return (
    <View style={styles.header} testID="pull-request-review-header">
      <View style={styles.headerRow}>
        <Pressable accessibilityRole="button" onPress={props.onBack} style={styles.button}>
          <Text style={styles.buttonText}>{t(`${K}.back`)}</Text>
        </Pressable>
        {onShowInMap ? (
          <Pressable
            accessibilityRole="button"
            onPress={showInMap}
            style={styles.button}
            testID="pull-request-review-show-in-map"
          >
            <Text style={styles.buttonText}>{t("panels.architectureMap.graph.showInMap")}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.title}>{`#${number} ${pr?.title ?? ""}`}</Text>
      <Text style={styles.muted}>
        {t(`${K}.meta`, {
          author: pr?.author ?? t(`${K}.unknownAuthor`),
          base: pr?.baseRefName ?? "?",
          head: pr?.headRefName ?? "?",
          commit: (payload.head ?? "").slice(0, 9),
        })}
      </Text>
      <View style={styles.badges}>
        <Badge
          tone={checkTone(checks.status)}
          text={t(`${K}.checks.${checks.status}`, { passed, total: checks.items.length })}
        />
        <AdwBadge adw={payload.adw ?? null} />
        {payload.reviewDecision ? (
          <Badge tone="neutral" text={t(`${K}.githubReview`, { state: payload.reviewDecision })} />
        ) : null}
      </View>
      <PullRequestFindings adw={payload.adw ?? null} />
    </View>
  );
}

type Tone = "good" | "warn" | "bad" | "neutral";
function checkTone(status: string): Tone {
  if (status === "success") return "good";
  if (status === "failure") return "bad";
  if (status === "pending") return "warn";
  return "neutral";
}
function verdictTone(verdict: string): Tone {
  if (/PASS|APPROVE/i.test(verdict)) return "good";
  if (/BLOCK|FAIL|REQUEST/i.test(verdict)) return "bad";
  return "warn";
}

function AdwBadge(props: { adw: Payload["adw"] | null }) {
  const { t } = useTranslation();
  if (!props.adw) return <Badge tone="neutral" text={t(`${K}.noAutomatedReview`)} />;
  const tier = props.adw.tier ? ` · ${props.adw.tier}` : "";
  return (
    <Badge
      tone={verdictTone(props.adw.verdict)}
      text={t(`${K}.adwVerdict`, { verdict: `${props.adw.verdict}${tier}` })}
    />
  );
}

function Badge(props: { tone: Tone; text: string }) {
  return (
    <View style={[styles.badge, badgeTone(props.tone)]}>
      <Text style={styles.badgeText}>{props.text}</Text>
    </View>
  );
}

function badgeTone(tone: Tone) {
  if (tone === "good") return styles.toneGood;
  if (tone === "bad") return styles.toneBad;
  if (tone === "warn") return styles.toneWarn;
  return styles.toneNeutral;
}

/** Findings that name no file: shown once, under the summary. */
function PullRequestFindings(props: { adw: Payload["adw"] | null }) {
  const { t } = useTranslation();
  const general = (props.adw?.findings ?? []).filter((f) => !f.file);
  if (general.length === 0) return null;
  return (
    <View style={styles.findings} testID="pull-request-review-findings">
      <Text style={styles.sectionTitle}>{t(`${K}.findingsTitle`, { count: general.length })}</Text>
      {general.map((f) => (
        <FindingRow key={`${f.source}-${f.severity}-${f.message}`} finding={f} />
      ))}
    </View>
  );
}

function FindingRow(props: { finding: Finding }) {
  const { finding } = props;
  const where = finding.line !== undefined ? `L${finding.line} · ` : "";
  return (
    <View style={styles.finding}>
      <Text style={[styles.severity, severityTone(finding.severity)]}>{finding.severity}</Text>
      <Text style={styles.body}>{`${where}${finding.message}`}</Text>
      <Text style={styles.muted}>{finding.source}</Text>
    </View>
  );
}

function severityTone(severity: string) {
  if (/blocker|error|major|high/i.test(severity)) return styles.textBad;
  if (/minor|warn|medium/i.test(severity)) return styles.textWarn;
  return styles.textMuted;
}

function FileList(props: {
  files: readonly ReviewFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupReviewFiles(props.files), [props.files]);
  const startHere = useMemo(() => startHerePath(props.files), [props.files]);
  const totals = props.files.reduce(
    (n, f) => ({ add: n.add + f.additions, del: n.del + f.deletions }),
    { add: 0, del: 0 },
  );
  return (
    <View style={styles.fileList} testID="pull-request-review-files">
      <Text style={styles.sectionTitle}>
        {t(`${K}.filesTitle`, {
          count: props.files.length,
          additions: totals.add,
          deletions: totals.del,
        })}
      </Text>
      {groups.map(([label, files]) => (
        <View key={label} style={styles.group}>
          <Text style={styles.groupTitle}>{label}</Text>
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              startHere={file.path === startHere}
              selected={file.path === props.selected}
              onSelect={props.onSelect}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function FileRow(props: {
  file: ReviewFile;
  startHere: boolean;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const { t } = useTranslation();
  const { file, onSelect } = props;
  const onPress = useCallback(() => onSelect(file.path), [file.path, onSelect]);
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  const folder = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      accessibilityHint={file.path}
      style={[styles.fileRow, props.selected && styles.fileRowSelected]}
      testID="pull-request-review-file"
    >
      <View style={styles.fileName}>
        <Text style={styles.body} numberOfLines={1}>
          {name}
          {props.startHere ? (
            <Text style={styles.startHere}>{`  ${t(`${K}.plain.startHere`)}`}</Text>
          ) : null}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {t(`${K}.plain.${plainFileKey(file)}`, { count: file.tests })}
          {folder ? ` · ${folder}` : ""}
        </Text>
      </View>
      <Text style={styles.plus}>{`+${file.additions}`}</Text>
      <Text style={styles.minus}>{`−${file.deletions}`}</Text>
      <View style={[styles.risk, riskTone(file.risk)]}>
        <Text style={styles.riskText}>{t(`${K}.risk.${file.risk}`)}</Text>
      </View>
    </Pressable>
  );
}

function riskTone(risk: ReviewFile["risk"]) {
  if (risk === "HIGH") return styles.toneBad;
  if (risk === "NORMAL") return styles.toneWarn;
  return styles.toneNeutral;
}

function FilePane(props: {
  serverId: string;
  cwd: string;
  payload: Payload;
  path: string | null;
  file: ReviewFile | null;
  onFlags: (path: string, flags: readonly ReviewFlag[]) => void;
  /** False once this review has asked for 30 summaries; later files get theirs on request. */
  autoSummary: boolean;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const diff = useReviewFileDiff({
    serverId: props.serverId,
    cwd: props.cwd,
    base: props.payload.base ?? null,
    head: props.payload.head ?? null,
    path: props.path,
  });
  const displayPreferences = useMemo(
    () => ({
      layout: "unified" as const,
      wrapLines: true,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [settings.codeFontSize, settings.monoFontFamily],
  );
  const files = useMemo(() => (diff.data?.file ? [diff.data.file] : []), [diff.data]);
  const findings = useMemo(
    () => (props.payload.adw?.findings ?? []).filter((f) => f.file && f.file === props.path),
    [props.payload.adw, props.path],
  );
  const file = props.file;
  const flags = useMemo(
    () => (file && diff.data ? reviewFlags(diff.data.file ?? null, file, findings) : null),
    [diff.data, file, findings],
  );
  const { onFlags } = props;
  useEffect(() => {
    if (file && flags) onFlags(file.path, flags);
  }, [file, flags, onFlags]);
  if (!props.file) return null;
  return (
    <View style={styles.pane} testID="pull-request-review-diff">
      <Text style={styles.sectionTitle}>{props.file.path}</Text>
      <Text style={styles.muted}>
        {t(`${K}.riskExplain.${props.file.risk}`, { count: props.file.tests })}
      </Text>
      <PlainWords
        serverId={props.serverId}
        cwd={props.cwd}
        base={props.payload.base ?? null}
        head={props.payload.head ?? null}
        path={props.file.path}
        autoSummary={props.autoSummary}
      />
      <FileFindings findings={findings} hasReview={Boolean(props.payload.adw)} />
      {flags ? <LookHere flags={flags} /> : null}
      {diff.isLoading ? <Text style={styles.muted}>{t(`${K}.loadingDiff`)}</Text> : null}
      {!diff.isLoading && files.length === 0 ? (
        <Text style={styles.muted}>{t(`${K}.noDiff`)}</Text>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.diffFrame}>
          {/* The diff draws into a measured viewport: it needs a frame with a height and scrolls inside. */}
          <DiffDocument files={files} displayPreferences={displayPreferences} mode={COMMIT_MODE} />
        </View>
      ) : null}
    </View>
  );
}

/** The rule-based places to look in this file; automated findings are listed just above, so they are not repeated. */
function LookHere(props: { flags: readonly ReviewFlag[] }) {
  const { t } = useTranslation();
  const own = props.flags.filter((flag) => flag.kind !== "finding");
  return (
    <View style={styles.findings} testID="pull-request-review-look-here">
      <Text style={styles.sectionTitle}>{t(`${K}.plain.lookHere`)}</Text>
      {own.length === 0 ? <Text style={styles.muted}>{t(`${K}.plain.nothingFlagged`)}</Text> : null}
      {own.map((flag) => (
        <View key={`${flag.kind}-${flag.line ?? 0}-${flag.text}`} style={styles.finding}>
          <Text style={styles.flagTitle}>
            {flag.line === null
              ? FLAG_LABEL[flag.kind]
              : `${t(`${K}.plain.line`, { line: flag.line })} · ${FLAG_LABEL[flag.kind]}`}
          </Text>
          <Text style={styles.code}>{flag.text}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * "In plain words" (2–3 sentences, asked when the file opens) and "Pseudocode of the change" (only when asked),
 * written by a cheap model on the host and cached there. Hidden on hosts that can't explain files.
 */
function PlainWords(props: {
  serverId: string;
  cwd: string;
  base: string | null;
  head: string | null;
  path: string;
  autoSummary: boolean;
}) {
  const { t } = useTranslation();
  const supported = useHostFeatureAvailability(props.serverId, "pullRequestReviewExplain") === true;
  const [askedSummary, setAskedSummary] = useState(false);
  const [askedPseudo, setAskedPseudo] = useState(false);
  const target = {
    serverId: props.serverId,
    cwd: props.cwd,
    base: props.base,
    head: props.head,
    path: props.path,
  };
  const summary = useReviewExplanation({
    ...target,
    kind: "summary",
    enabled: supported && (props.autoSummary || askedSummary),
  });
  const pseudo = useReviewExplanation({
    ...target,
    kind: "pseudocode",
    enabled: supported && askedPseudo,
  });
  const askSummary = useCallback(() => setAskedSummary(true), []);
  const askPseudo = useCallback(() => setAskedPseudo(true), []);
  if (!supported) return null;
  const used = pseudo.data?.usedToday ?? summary.data?.usedToday;
  const limit = pseudo.data?.dailyLimit ?? summary.data?.dailyLimit;
  return (
    <View style={styles.findings} testID="pull-request-review-plain-words">
      <Text style={styles.sectionTitle}>{t(`${K}.plain.inPlainWords`)}</Text>
      {props.autoSummary || askedSummary ? (
        <ExplanationText query={summary} />
      ) : (
        <Pressable accessibilityRole="button" onPress={askSummary} style={styles.button}>
          <Text style={styles.buttonText}>{t(`${K}.plain.explainFile`)}</Text>
        </Pressable>
      )}
      {askedPseudo ? (
        <>
          <Text style={styles.sectionTitle}>{t(`${K}.plain.pseudocode`)}</Text>
          <ExplanationText query={pseudo} mono />
        </>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={askPseudo}
          style={styles.button}
          testID="pull-request-review-ask-pseudocode"
        >
          <Text style={styles.buttonText}>{t(`${K}.plain.showPseudocode`)}</Text>
        </Pressable>
      )}
      {used !== undefined && limit !== undefined ? (
        <Text style={styles.muted}>{t(`${K}.plain.usedToday`, { used, limit })}</Text>
      ) : null}
    </View>
  );
}

function ExplanationText(props: {
  query: ReturnType<typeof useReviewExplanation>;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  const { query } = props;
  if (query.isLoading) return <Text style={styles.muted}>{t(`${K}.plain.writing`)}</Text>;
  const data = query.data;
  if (data?.status === "ok" && data.text)
    return <Text style={props.mono ? styles.code : styles.body}>{data.text}</Text>;
  if (data?.status === "limit")
    return <Text style={styles.muted}>{t(`${K}.plain.limitReached`)}</Text>;
  return <Text style={styles.muted}>{t(`${K}.plain.unavailable`)}</Text>;
}

function BeforeYouApprove(props: {
  files: readonly ReviewFile[];
  flagsByPath: ReadonlyMap<string, readonly ReviewFlag[]>;
}) {
  const { t } = useTranslation();
  const items = useMemo(
    () => beforeYouApprove({ files: props.files, flagsByPath: props.flagsByPath }),
    [props.files, props.flagsByPath],
  );
  return (
    <View style={styles.findings} testID="pull-request-review-checklist">
      <Text style={styles.sectionTitle}>{t(`${K}.plain.beforeApprove`)}</Text>
      {items.map((item) => (
        <Text key={item.key} style={item.state === "look" ? styles.textWarn : styles.body}>
          {`${CHECK_MARK[item.state]}  ${item.text}`}
        </Text>
      ))}
    </View>
  );
}
const CHECK_MARK = { ok: "✓", look: "!", unknown: "·" } as const;

function sameFlags(a: readonly ReviewFlag[], b: readonly ReviewFlag[]): boolean {
  return (
    a.length === b.length &&
    a.every((f, i) => f.kind === b[i]?.kind && f.line === b[i]?.line && f.text === b[i]?.text)
  );
}

function FileFindings(props: { findings: readonly Finding[]; hasReview: boolean }) {
  const { t } = useTranslation();
  if (props.findings.length > 0) {
    return (
      <View style={styles.findings} testID="pull-request-review-file-findings">
        {props.findings.map((f) => (
          <FindingRow key={`${f.line ?? 0}-${f.severity}-${f.message}`} finding={f} />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.notice}>
      <Text style={styles.muted}>
        {t(props.hasReview ? `${K}.noFindingsHere` : `${K}.noAutomatedReviewYet`)}
      </Text>
    </View>
  );
}

function DecisionBar(props: {
  serverId: string;
  cwd: string;
  pullRequest: number;
  headOid: string;
  url?: string;
  recorded: Decision | null;
  onRecorded: (decision: Decision) => void;
}) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[props.serverId]?.client ?? null);
  const [choice, setChoice] = useState<PullRequestReviewDecisionKind>("approve");
  const [note, setNote] = useState("");
  const [post, setPost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { cwd, pullRequest, headOid, onRecorded } = props;
  const record = useCallback(() => {
    if (!client) return;
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        const result = await client.decidePullRequestReview({
          cwd,
          pullRequest,
          headOid,
          decision: choice,
          note,
          postToGithub: post,
        });
        if (result.status === "ok" && result.decision) onRecorded(result.decision);
        else setError(result.error ?? "");
        // G4 Inbox: also record it as an Inbox item when the host offers it; the host file above stays the fallback.
        if (result.status === "ok")
          void recordReviewInInbox(client, props.serverId, {
            workspace: cwd,
            url: props.url,
            pullRequest,
            headOid,
            decision: choice,
            note,
          });
      } catch (e) {
        setError(e instanceof Error ? e.message : "");
      } finally {
        setSaving(false);
      }
    })();
  }, [
    client,
    cwd,
    pullRequest,
    headOid,
    choice,
    note,
    post,
    onRecorded,
    props.serverId,
    props.url,
  ]);
  return (
    <View style={styles.decision} testID="pull-request-review-decision">
      <Text style={styles.sectionTitle}>{t(`${K}.decisionTitle`)}</Text>
      <View style={styles.choices}>
        {DECISIONS.map((kind) => (
          <ChoiceChip key={kind} kind={kind} selected={kind === choice} onChoose={setChoice} />
        ))}
      </View>
      <EditingTextInput
        onChangeText={setNote}
        placeholder={t(`${K}.notePlaceholder`)}
        multiline
        style={styles.note}
        testID="pull-request-review-note"
        accessibilityLabel={t(`${K}.notePlaceholder`)}
      />
      <View style={styles.postRow}>
        <Switch
          value={post}
          onValueChange={setPost}
          accessibilityLabel={t(`${K}.postToGithub`)}
          testID="pull-request-review-post"
        />
        <View style={styles.fileName}>
          <Text style={styles.body}>{t(`${K}.postToGithub`)}</Text>
          <Text style={styles.muted}>{t(post ? `${K}.postOn` : `${K}.postOff`)}</Text>
        </View>
      </View>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          onPress={record}
          disabled={saving || !headOid}
          style={[styles.primary, saving && styles.disabled]}
          testID="pull-request-review-record"
        >
          <Text style={styles.primaryText}>{t(saving ? `${K}.recording` : `${K}.record`)}</Text>
        </Pressable>
        {error !== null ? <Text style={styles.textBad}>{t(`${K}.recordFailed`)}</Text> : null}
      </View>
      {props.recorded ? <RecordedCard decision={props.recorded} /> : null}
    </View>
  );
}

function ChoiceChip(props: {
  kind: PullRequestReviewDecisionKind;
  selected: boolean;
  onChoose: (kind: PullRequestReviewDecisionKind) => void;
}) {
  const { t } = useTranslation();
  const { kind, onChoose } = props;
  const onPress = useCallback(() => onChoose(kind), [kind, onChoose]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={props.selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, props.selected && styles.chipOn]}
      testID={`pull-request-review-choice-${kind}`}
    >
      <Text style={styles.chipText}>{t(`${K}.choice.${DECISION_KEY[kind]}`)}</Text>
    </Pressable>
  );
}

function RecordedCard(props: { decision: Decision }) {
  const { t } = useTranslation();
  const { decision } = props;
  const when = new Date(decision.at).toLocaleString();
  let where = t(`${K}.recordedLocal`);
  if (decision.postedToGithub) where = t(`${K}.recordedPosted`);
  else if (decision.postError) where = t(`${K}.recordedPostFailed`);
  return (
    <View style={styles.recorded} testID="pull-request-review-recorded">
      <Text style={styles.body}>
        {t(`${K}.recorded`, {
          decision: t(`${K}.choice.${DECISION_KEY[decision.decision]}`),
          when,
        })}
      </Text>
      {decision.note ? <Text style={styles.body}>{`“${decision.note}”`}</Text> : null}
      <Text style={styles.muted}>{where}</Text>
    </View>
  );
}

function Centered(props: { text: string; detail?: string | null }) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>{props.text}</Text>
      {props.detail ? <Text style={styles.muted}>{props.detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  header: { gap: theme.spacing[1.5] },
  headerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  textBad: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  textWarn: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  textMuted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  button: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  buttonText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  badge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
  },
  badgeText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  toneGood: { borderColor: theme.colors.statusSuccess },
  toneBad: { borderColor: theme.colors.statusDanger },
  toneWarn: { borderColor: theme.colors.statusWarning },
  toneNeutral: { borderColor: theme.colors.border },
  columns: { flexDirection: "row", gap: theme.spacing[3], alignItems: "flex-start" },
  stack: { gap: theme.spacing[3] },
  sidebar: { width: 340 },
  full: { alignSelf: "stretch" },
  main: { flex: 1, minWidth: 0 },
  fileList: { gap: theme.spacing[2] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  group: { gap: theme.spacing[0.5] },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  fileRowSelected: { backgroundColor: theme.colors.surface2 },
  fileName: { flex: 1, minWidth: 0, gap: theme.spacing[0.5] },
  plus: { color: theme.colors.statusSuccess, fontSize: theme.fontSize.sm },
  minus: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  risk: {
    paddingHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
  },
  riskText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  startHere: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  pane: { gap: theme.spacing[2] },
  diffFrame: {
    height: 560,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  findings: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  finding: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "baseline",
  },
  severity: { fontWeight: theme.fontWeight.semibold, textTransform: "uppercase" },
  flagTitle: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  notice: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  decision: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.borderAccent },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  note: {
    minHeight: 72,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  postRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  primary: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  primaryText: {
    color: theme.colors.surface0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  disabled: { opacity: 0.5 },
  recorded: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusSuccess,
  },
}));

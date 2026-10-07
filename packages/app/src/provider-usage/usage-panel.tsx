import React, { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { AccountUsageRow } from "./types";
import {
  otherAccountRows,
  tokenBreakdown,
  validCount,
  windowReading,
  type RecordedTokens,
  type UsagePanelChat,
} from "./panel-model";

export interface UsagePanelProps {
  chat: UsagePanelChat;
  account: AccountUsageRow | null;
  accountName: string | null;
  identityAvailable: boolean;
  accounts: AccountUsageRow[];
  status: "loading" | "ready" | "unsupported" | "offline" | "error" | "permission";
  readingAt: number;
  busy?: boolean;
  onRefresh?: () => void;
  /** Off where the context window details already show this chat's context above the panel. */
  showChat?: boolean;
}
function number(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}
function date(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function TokenRows({ values }: { values: RecordedTokens }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      {Object.entries(tokenBreakdown(values)).map(([key, value]) => (
        <Metric
          key={key}
          label={t(`usagePanel.tokens.${key}`)}
          value={value === null ? t("usagePanel.notReported") : number(value, i18n.language)}
        />
      ))}
    </>
  );
}
function Allowance({
  label,
  value,
  id,
  now,
}: {
  label: string;
  value: AccountUsageRow["fiveHour"];
  id: string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const reading = windowReading(value, now);
  const percent = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const valueLabel =
    reading.used === null
      ? t("usagePanel.notReported")
      : t("usagePanel.allowance", {
          used: percent.format(reading.used),
          remaining: percent.format(reading.remaining ?? 0),
        });
  let reset = t("usagePanel.resetNotReported");
  if (reading.resetsAt !== null) {
    const localDate = date(reading.resetsAt, i18n.language);
    if (reading.expired) reset = t("usagePanel.resetPassed", { date: localDate });
    else {
      const minutes = reading.minutesLeft ?? 0;
      reset = t("usagePanel.resetAt", {
        date: localDate,
        countdown: t("usagePanel.countdown", {
          hours: Math.floor(minutes / 60),
          minutes: minutes % 60,
        }),
      });
    }
  }
  const fill = useMemo(
    () => [
      styles.fill,
      reading.used === 100 && styles.limitedFill,
      { width: `${reading.used ?? 0}%` as const },
    ],
    [reading.used],
  );
  const accessibilityValue = useMemo(
    () => ({ min: 0, max: 100, now: reading.used ?? 0 }),
    [reading.used],
  );
  return (
    <View style={styles.window} testID={`usage-window-${id}`}>
      <Metric label={label} value={valueLabel} />
      {reading.used !== null ? (
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={label}
          accessibilityValue={accessibilityValue}
        >
          <View style={fill} />
        </View>
      ) : null}
      <Text style={styles.detail}>{reset}</Text>
    </View>
  );
}
function AccountDetails({
  row,
  host,
  id,
  now,
}: {
  row: AccountUsageRow;
  host: string | null;
  id: string;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const observed = row.observedAt ? Date.parse(row.observedAt) : NaN;
  const observedLabel = Number.isFinite(observed)
    ? t("usagePanel.observed", { date: date(observed, i18n.language) })
    : t("usagePanel.observationMissing");
  const count =
    row.sessionCount === undefined
      ? t("usagePanel.countUnknown")
      : t("usagePanel.residentCount", {
          count: row.sessionCount,
          host: host ?? t("usagePanel.notReported"),
        });
  return (
    <View style={styles.group}>
      {row.status === "limited" ? (
        <Text style={styles.error}>{t("usagePanel.limited")}</Text>
      ) : null}
      <Allowance label={t("usagePanel.fiveHour")} value={row.fiveHour} id={`${id}-5h`} now={now} />
      <Allowance label={t("usagePanel.sevenDay")} value={row.weekly} id={`${id}-7d`} now={now} />
      <Text style={styles.detail}>{t("usagePanel.scopeUnknown")}</Text>
      <Text style={styles.detail}>
        {observedLabel}
        {row.source ? ` · ${t(`usagePanel.source.${row.source}`)}` : ""}
      </Text>
      <Text style={styles.detail}>{count}</Text>
    </View>
  );
}
function ChatSummary({ chat }: { chat: UsagePanelChat }) {
  const { t, i18n } = useTranslation();
  const used = validCount(chat.contextUsed),
    limit = validCount(chat.contextLimit);
  const valid = used !== null && limit !== null && limit > 0;
  const context = valid
    ? t("contextWindow.used", { percentage: Math.round((used / limit) * 100) })
    : t("usagePanel.notReported");
  let summary = t("usagePanel.totalUnknown");
  if (chat.recorded?.total?.scope === "provider-query") {
    const values = tokenBreakdown(chat.recorded.total.tokens);
    summary = t("usagePanel.querySummary", {
      input:
        values.input === null ? t("usagePanel.notReported") : number(values.input, i18n.language),
      output:
        values.output === null ? t("usagePanel.notReported") : number(values.output, i18n.language),
    });
  }
  const missing = t("usagePanel.notReported");
  const effort = chat.effort
    ? t("usagePanel.effort", { effort: chat.effort })
    : t("usagePanel.effortUnknown");
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>{t("usagePanel.thisChat")}</Text>
      <Text
        style={styles.identity}
      >{`${chat.provider ?? missing} · ${chat.model ?? missing} · ${effort}`}</Text>
      <Text style={styles.detail}>{t("usagePanel.host", { host: chat.host ?? missing })}</Text>
      <Metric label={t("contextWindow.title")} value={context} />
      <Text style={styles.detail}>
        {valid
          ? t("contextWindow.tokens", {
              used: number(used, i18n.language),
              max: number(limit, i18n.language),
            })
          : t("usagePanel.contextUnknown")}
      </Text>
      <Text style={styles.detail}>{summary}</Text>
    </View>
  );
}
function CostEstimate({ recorded }: { recorded: UsagePanelChat["recorded"] }) {
  const { t, i18n } = useTranslation();
  const estimate = recorded?.estimate;
  if (
    estimate?.kind !== "provider-api-estimate" ||
    estimate.scope !== "provider-query" ||
    validCount(estimate.amountUsd) === null
  )
    return null;
  const digits = estimate.amountUsd > 0 && estimate.amountUsd < 0.01 ? 4 : 2;
  const cost = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(estimate.amountUsd);
  return (
    <>
      <Text style={styles.detail}>{t("usagePanel.costEstimate", { cost })}</Text>
      <Text style={styles.detail}>{t("usagePanel.costNote")}</Text>
    </>
  );
}
function TokenDetails({ recorded }: { recorded: UsagePanelChat["recorded"] }) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const observed = recorded ? Date.parse(recorded.observedAt) : NaN;
  return (
    <View style={styles.section}>
      <Button
        variant="ghost"
        size="sm"
        style={styles.touchAction}
        onPress={toggle}
        accessibilityState={accessibilityState}
        testID="usage-token-details"
      >
        {t("usagePanel.tokenDetails")}
      </Button>
      <Text style={styles.detail}>{t("usagePanel.lifetimeUnknown")}</Text>
      {expanded ? (
        <View style={styles.group}>
          <Text style={styles.heading}>
            {recorded?.total?.scope === "provider-query"
              ? t("usagePanel.queryTotal")
              : t("usagePanel.totalUnknown")}
          </Text>
          {recorded?.total ? (
            <TokenRows values={recorded.total.tokens} />
          ) : (
            <Text style={styles.detail}>{t("usagePanel.notReported")}</Text>
          )}
          {recorded?.total?.scope === "provider-query" ? (
            <Text style={styles.detail}>{t("usagePanel.queryScope")}</Text>
          ) : null}
          <Text style={styles.heading}>{t("usagePanel.latestReport")}</Text>
          {recorded?.latest ? (
            <TokenRows values={recorded.latest.tokens} />
          ) : (
            <Text style={styles.detail}>{t("usagePanel.notReported")}</Text>
          )}
          <Text style={styles.detail}>{t("usagePanel.lastRequestUnknown")}</Text>
          {recorded ? (
            <Text style={styles.detail}>
              {t("usagePanel.recordedAt", {
                date: Number.isFinite(observed)
                  ? date(observed, i18n.language)
                  : t("usagePanel.notReported"),
                source: recorded.provider === "claude" ? "Claude SDK" : "Codex",
              })}
            </Text>
          ) : null}
          <CostEstimate recorded={recorded} />
        </View>
      ) : null}
    </View>
  );
}
function OtherAccounts({
  accounts,
  host,
  now,
}: {
  accounts: AccountUsageRow[];
  host: string | null;
  now: number;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.section}>
      <Button
        variant="ghost"
        size="sm"
        style={styles.touchAction}
        onPress={toggle}
        accessibilityState={accessibilityState}
        testID="usage-other-accounts"
      >
        {t("usagePanel.otherAccounts", { count: accounts.length })}
      </Button>
      {expanded ? (
        <View style={styles.group}>
          <Text style={styles.detail}>{t("usagePanel.observedRoster")}</Text>
          {accounts.length === 0 ? (
            <Text style={styles.detail}>{t("usagePanel.noOtherAccounts")}</Text>
          ) : (
            accounts.map((row) => (
              <View key={`${row.provider}:${row.accountId ?? row.name}`} style={styles.section}>
                <Text style={styles.identity}>{`${row.name} · ${row.provider}`}</Text>
                <AccountDetails
                  row={row}
                  host={host}
                  id={`other-${row.provider}-${row.accountId ?? row.name}`}
                  now={now}
                />
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
export function UsagePanel({
  chat,
  account,
  accountName,
  identityAvailable,
  accounts,
  status,
  readingAt,
  busy = false,
  onRefresh,
  showChat = true,
}: UsagePanelProps) {
  const { t } = useTranslation();
  const others = otherAccountRows(accounts, account);
  return (
    <View style={styles.container} testID="chat-usage-panel">
      {showChat ? <ChatSummary chat={chat} /> : null}
      <View style={styles.section}>
        <View style={styles.metric}>
          <Text style={styles.heading}>{t("usagePanel.accountPlan")}</Text>
          {onRefresh ? (
            <Button
              variant="ghost"
              size="sm"
              style={styles.touchAction}
              onPress={onRefresh}
              loading={busy}
              disabled={busy}
              accessibilityLabel={t("usagePanel.refresh")}
              testID="usage-observation-refresh"
            >
              {t("usagePanel.refresh")}
            </Button>
          ) : null}
        </View>
        <Text style={styles.identity}>{accountName ?? t("usagePanel.accountUnknown")}</Text>
        {!identityAvailable ? (
          <Text style={styles.detail}>{t("usagePanel.identityUnavailable")}</Text>
        ) : null}
        {status !== "ready" ? (
          <Text
            style={status === "error" ? styles.error : styles.detail}
            accessibilityLiveRegion="polite"
          >
            {t(`usagePanel.state.${status}`)}
          </Text>
        ) : null}
        {account ? (
          <AccountDetails row={account} host={chat.host} id="bound" now={readingAt} />
        ) : (
          <View style={styles.group}>
            <Allowance
              label={t("usagePanel.fiveHour")}
              value={null}
              id="bound-5h"
              now={readingAt}
            />
            <Allowance
              label={t("usagePanel.sevenDay")}
              value={null}
              id="bound-7d"
              now={readingAt}
            />
          </View>
        )}
        <Text style={styles.detail}>{t("usagePanel.passive")}</Text>
      </View>
      <TokenDetails recorded={chat.recorded} />
      <OtherAccounts accounts={others} host={chat.host} now={readingAt} />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { padding: theme.spacing[3], gap: theme.spacing[3], flexShrink: 1 },
  touchAction: { minHeight: 44 },
  group: { gap: theme.spacing[1] },
  section: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
    paddingTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  identity: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    flexShrink: 1,
  },
  metric: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  window: { gap: theme.spacing[1] },
  track: { height: 4, borderRadius: 2, backgroundColor: theme.colors.surface3, overflow: "hidden" },
  fill: { height: 4, backgroundColor: theme.colors.foregroundMuted },
  limitedFill: { backgroundColor: theme.colors.destructive },
}));

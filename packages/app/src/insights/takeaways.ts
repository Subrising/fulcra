import type { InsightsResult } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";

// One plain sentence per chart. The rules are deliberately simple so the sentence can be checked against the chart
// it sits under: a measure that at least doubled or halved against the previous period of the same length is called
// out; otherwise the sentence states the measure.

type Delivery = NonNullable<InsightsResult["delivery"]>;
type Agents = InsightsResult["agents"];
const K = "insights.takeaway";

export function duration(t: TFunction, hours: number): string {
  if (hours <= 0) return t("insights.duration.minutes", { count: 0 });
  if (hours < 1)
    return t("insights.duration.minutes", { count: Math.max(1, Math.round(hours * 60)) });
  if (hours < 48) return t("insights.duration.hours", { count: Math.round(hours * 10) / 10 });
  return t("insights.duration.days", { count: Math.round((hours / 24) * 10) / 10 });
}

export type Trend = "doubled" | "halved" | "steady";
export function trend(now: number | null, before: number | null): Trend {
  if (now === null || before === null || before <= 0) return "steady";
  if (now >= before * 2) return "doubled";
  if (now <= before / 2) return "halved";
  return "steady";
}

export function cycleTakeaway(t: TFunction, d: Delivery): string {
  const median = d.cycleHours.median;
  if (median === null) return t(`${K}.cycleNone`, { days: d.days });
  const change = trend(median, d.previous.cycleMedianHours);
  if (change === "steady") return t(`${K}.cycle`, { median: duration(t, median) });
  return t(`${K}.cycle_${change}`, {
    median: duration(t, median),
    before: duration(t, d.previous.cycleMedianHours ?? 0),
  });
}

export function reviewTakeaway(t: TFunction, d: Delivery): string {
  const median = d.reviewWaitHours.median;
  if (median === null) {
    return d.waitingOverTwoDays > 0
      ? t(`${K}.reviewNoneWaiting`, { count: d.waitingOverTwoDays })
      : t(`${K}.reviewNone`);
  }
  const change = trend(median, d.previous.reviewWaitMedianHours);
  const values = { median: duration(t, median), count: d.waitingOverTwoDays };
  if (change === "doubled") {
    return t(`${K}.review_doubled`, {
      ...values,
      before: duration(t, d.previous.reviewWaitMedianHours ?? 0),
    });
  }
  return t(`${K}.review`, values);
}

export function mergeTakeaway(t: TFunction, d: Delivery): string {
  if (d.mergeRate === null) return t(`${K}.mergeNone`);
  return t(`${K}.merge`, {
    percent: Math.round(d.mergeRate * 100),
    merged: d.merged,
    closed: d.closedUnmerged,
  });
}

export function openTakeaway(t: TFunction, d: Delivery): string {
  const a = d.openByAge;
  const open = a.lt1d + a.d1to3 + a.d3to7 + a.d7to30 + a.gt30d;
  if (open === 0) return t(`${K}.openNone`);
  return t(`${K}.open`, { count: open, old: a.d7to30 + a.gt30d });
}

export function sessionsTakeaway(t: TFunction, a: Agents): string {
  const busiest = [...a.perDay].sort((x, y) => y.started - x.started)[0];
  if (!busiest || a.totals.started === 0) return t(`${K}.sessionsNone`, { days: a.days });
  const change = trend(a.totals.started, a.previous.started);
  return t(change === "steady" ? `${K}.sessions` : `${K}.sessions_${change}`, {
    started: a.totals.started,
    finished: a.totals.finished,
    day: busiest.day.slice(5),
    count: busiest.started,
    before: a.previous.started,
  });
}

export function blockedTakeaway(t: TFunction, a: Agents): string {
  const since = a.recordingSince?.slice(0, 10) ?? null;
  if (since === null) return t(`${K}.blockedNotRecording`, { now: a.totals.waitingNow });
  if (a.totals.blocked === 0) return t(`${K}.blockedNone`, { since, now: a.totals.waitingNow });
  return t(`${K}.blocked`, {
    count: a.totals.blocked,
    time: duration(t, a.totals.blockedHours),
    now: a.totals.waitingNow,
  });
}

export function limitsTakeaway(t: TFunction, a: Agents): string {
  const since = a.recordingSince?.slice(0, 10) ?? null;
  if (a.totals.limitStops === 0) return t(`${K}.limitsNone`, { since: since ?? "—" });
  const top = [...a.byProject].sort((x, y) => y.limitStops - x.limitStops)[0];
  return t(`${K}.limits`, {
    count: a.totals.limitStops,
    project: top?.name || t("insights.otherFolders"),
  });
}

export function projectsTakeaway(t: TFunction, a: Agents): string {
  const top = a.byProject.find((p) => p.started > 0);
  if (!top) return t(`${K}.sessionsNone`, { days: a.days });
  return t(`${K}.projects`, { name: top.name || t("insights.otherFolders"), count: top.started });
}

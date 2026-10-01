import type { Automation, AutomationRun } from "@getpaseo/protocol/messages";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { describeCron } from "@/utils/schedule-format";

// Plain-language "When X, do Y" sentences for automations and their runs, in the reader's language.

type T = (key: string, options?: Record<string, unknown>) => string;

const K = "automations";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  pi: "Pi",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export interface AutomationNames {
  project: (id: string) => string | undefined;
  session: (id: string) => string | undefined;
  template: (id: string) => string | undefined;
}

export function describeCadence(t: T, cadence: ScheduleCadence): string {
  if (cadence.type === "cron") return describeCron(cadence) ?? cadence.expression;
  const ms = cadence.everyMs;
  if (ms % DAY === 0) return t(`${K}.cadence.days`, { count: ms / DAY });
  if (ms % HOUR === 0) return t(`${K}.cadence.hours`, { count: ms / HOUR });
  return t(`${K}.cadence.minutes`, { count: Math.max(1, Math.round(ms / MINUTE)) });
}

export function describeTrigger(
  t: T,
  trigger: Automation["trigger"],
  names: AutomationNames,
): string {
  if (trigger.kind === "schedule") {
    return t(`${K}.when.schedule`, { cadence: describeCadence(t, trigger.cadence) });
  }
  if (trigger.kind === "pull_request") {
    const project = names.project(trigger.projectId) ?? t(`${K}.unknownProject`);
    const events = trigger.events.length === 2 ? "both" : trigger.events[0];
    return t(`${K}.when.pullRequest.${events}`, { project });
  }
  const project = trigger.projectId ? names.project(trigger.projectId) : undefined;
  return project
    ? t(`${K}.when.session.${trigger.event}InProject`, { project })
    : t(`${K}.when.session.${trigger.event}`);
}

export function describeAction(t: T, action: Automation["action"], names: AutomationNames): string {
  if (action.kind === "start_session") {
    const template = action.profileId ? names.template(action.profileId) : undefined;
    return t(`${K}.do.startSession`, {
      template: template ?? providerLabel(action.provider),
      project: names.project(action.projectId) ?? t(`${K}.unknownProject`),
    });
  }
  if (action.kind === "message_session") {
    return t(`${K}.do.messageSession`, {
      session: names.session(action.agentId) || t(`${K}.untitledSession`),
    });
  }
  return t(action.postToGithub ? `${K}.do.noteAndPost` : `${K}.do.note`);
}

/** What started a run, for the history. */
export function describeRunSource(t: T, run: AutomationRun, automation: Automation): string {
  if (run.manual) return t(`${K}.run.manual`);
  const trigger = automation.trigger;
  if (trigger.kind === "schedule") return t(`${K}.run.schedule`);
  if (trigger.kind === "pull_request") {
    return run.pullRequest === undefined
      ? t(`${K}.run.pullRequestAny`)
      : t(`${K}.run.pullRequest`, { number: run.pullRequest });
  }
  return t(`${K}.run.session.${trigger.event}`);
}

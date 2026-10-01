import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Automation,
  AutomationAction,
  AutomationDeleteRequest,
  AutomationInput,
  AutomationListRequest,
  AutomationRun,
  AutomationRunNowRequest,
  AutomationSaveRequest,
  AutomationSetEnabledRequest,
  AutomationTrigger,
} from "@getpaseo/protocol/messages";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  UpdateScheduleInput,
} from "@getpaseo/protocol/schedule/types";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import { USAGE_LIMIT } from "../../utils/insights/agents.js";

// Automations (GitKraken Automations): "when X, do Y" on top of Schedules.
// - Starting or messaging a session goes through a backing Schedule the automation owns: a schedule trigger is that
//   schedule's own cadence; an event trigger (pull request, session) keeps it paused and runs it once per event
//   with the event written into the prompt. Schedules' own runner does the work and keeps its own run log.
// - "Record a note" is kept on this host (the Command Centre Inbox has no operator method to write to).
// - Nothing leaves Fulcra unless an automation opts in: a note on a pull request trigger may also be posted to the
//   pull request with the user's gh sign-in.
// Safety:
// - Sessions an automation starts are never unattended unless the person chose that for the automation: they start in
//   the permission mode a person's session gets and ask before acting (the prompt can carry a pull request's number,
//   never its text).
// - Sessions started by a schedule never trigger session automations, nor does a session an automation messaged in
//   the last half hour (persisted, so a restart keeps it).
// - Each automation fires at most MAX_PER_DAY times a day, at most MAX_PER_SUBJECT_PER_DAY times for the same pull
//   request or session, and never twice within a minute for the same one. The counts are kept apart from the run
//   history, so skipped runs cannot push them out.
// - "Updated" means new commits; comments (the automation's own included) never re-trigger it.

export const MAX_RUNS_KEPT = 50;
export const MAX_PER_DAY = 20;
export const MAX_PER_SUBJECT_PER_DAY = 3;
const MIN_GAP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PULL_REQUEST_POLL_MS = 5 * 60_000;
const FIRST_POLL_MS = 30_000;
const PAUSED_CADENCE: ScheduleCadence = { type: "every", everyMs: 365 * 24 * 60 * 60 * 1000 };
const DRIVEN_MS = 30 * 60_000;

interface SchedulerRun {
  id: string;
  startedAt: string;
  status: string;
  agentId: string | null;
  error: string | null;
}

export interface AutomationScheduler {
  inspect(id: string): Promise<{ runs: SchedulerRun[] }>;
  create(input: CreateScheduleInput): Promise<{ id: string }>;
  update(input: UpdateScheduleInput): Promise<unknown>;
  pause(id: string): Promise<unknown>;
  resume(id: string): Promise<unknown>;
  delete(id: string): Promise<void>;
  runOnce(id: string): Promise<{ runs: SchedulerRun[] }>;
}

export interface AutomationDeps {
  paseoHome: string;
  schedules: AutomationScheduler;
  projectRoot: (projectId: string) => Promise<string | null>;
  projectOfAgent: (agentId: string) => Promise<{
    projectId: string | null;
    labels: Record<string, string>;
    /** Internal or archived sessions cannot be an automation's target. */
    internal?: boolean;
    archived?: boolean;
  } | null>;
  runGh: (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
  /** A template (agent profile) by id. */
  profile?: (id: string) => AutomationTemplate | null;
  now?: () => number;
}

export interface AutomationTemplate {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

/** One fire an automation counted (manual runs excluded): kept for 24 h, apart from the run history. */
export interface FireRecord {
  at: number;
  subject?: string;
}

interface StoreFile {
  version: 1;
  automations: Automation[];
  /** Per project, pull request number → head commit. */
  pullRequestsSeen: Record<string, Record<string, string>>;
  /** Per automation, its fires in the last 24 h. */
  fires: Record<string, FireRecord[]>;
  /** Session id → until when an automation-driven session cannot trigger session automations. */
  driven: Record<string, number>;
}

function emptyStore(): StoreFile {
  return { version: 1, automations: [], pullRequestsSeen: {}, fires: {}, driven: {} };
}

export interface TriggerEvent {
  summary: string;
  /** What the event is about (a pull request, a session), for the once-a-minute guard. */
  subject?: string;
  projectId?: string | null;
  pullRequest?: number;
}

export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "schedule") return "schedule";
  if (trigger.kind === "pull_request") return `pull request ${trigger.events.join("/")}`;
  return `session ${trigger.event}`;
}

/** The prompt a session gets: the automation's own words, then what triggered it. */
export function renderPrompt(prompt: string, event: TriggerEvent): string {
  const body = prompt.replaceAll("{{event}}", event.summary).trim();
  return `${body}\n\n(Started by a Fulcra automation: ${event.summary}.)`;
}

/** Which session event (if any) an agent manager event is. */
export function sessionEventOf(input: {
  type: string;
  agentId?: string;
  event?: { type?: string; reason?: unknown; error?: unknown; code?: unknown };
}): "finished" | "blocked" | "usage_limit" | null {
  if (input.type !== "agent_stream" || !input.event) return null;
  const e = input.event;
  if (e.type === "attention_required" && e.reason === "finished") return "finished";
  if (e.type === "permission_requested") return "blocked";
  if (
    e.type === "turn_failed" &&
    USAGE_LIMIT.test(`${String(e.error ?? "")} ${String(e.code ?? "")}`)
  ) {
    return "usage_limit";
  }
  return null;
}

/** A backing schedule's own runs (a schedule trigger's cadence) as automation runs. */
export function scheduleRunsAsAutomationRuns(runs: readonly SchedulerRun[]): AutomationRun[] {
  return runs.map((r) => {
    const run: AutomationRun = {
      id: r.id,
      at: r.startedAt,
      trigger: "schedule",
      status: SCHEDULE_RUN_STATUS[r.status] ?? "failed",
    };
    if (r.agentId) run.agentId = r.agentId;
    if (r.error) run.detail = r.error.slice(0, 300);
    return run;
  });
}

const SCHEDULE_RUN_STATUS: Record<string, AutomationRun["status"]> = {
  running: "running",
  succeeded: "ok",
  failed: "failed",
};

/** Whether an automation may fire now, from its own fire log (not its run history). */
export function mayFire(input: {
  enabled: boolean;
  fires: readonly FireRecord[];
  now: number;
  subject?: string;
}): boolean {
  if (!input.enabled) return false;
  const today = input.fires.filter((f) => input.now - f.at < DAY_MS);
  if (today.length >= MAX_PER_DAY) return false;
  if (!input.subject) return true;
  const same = today.filter((f) => f.subject === input.subject);
  if (same.length >= MAX_PER_SUBJECT_PER_DAY) return false;
  // The same pull request or session again within a minute is a loop or a duplicate, not a new event.
  const last = same[same.length - 1];
  return !last || input.now - last.at >= MIN_GAP_MS;
}

/** The head commit in a stored "seen" value (older hosts stored "head@updatedAt"). */
function headOf(value: string): string {
  return value.split("@")[0];
}

/** How a pull request moved between two polls: new, or new commits. Comments and edits are not updates. */
export function changeOf(before: string | undefined, head: string): PullRequestEvent | null {
  if (before === undefined) return "opened";
  return headOf(before) === head ? null : "updated";
}

/** Whether a mode id is the provider's unattended (never asks) mode. */
export function isUnattendedMode(provider: string, modeId: string | undefined): boolean {
  return modeId !== undefined && modeId === getUnattendedModeId(provider);
}

type PullRequestEvent = "opened" | "updated";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "Failed";
}

export class AutomationService {
  private store: StoreFile = emptyStore();
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstPoll: ReturnType<typeof setTimeout> | null = null;
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly deps: AutomationDeps) {}

  private get file() {
    return path.join(this.deps.paseoHome, "automations", "automations.json");
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    await this.load();
    // A run still marked running was cut short by a host restart.
    for (const run of this.store.automations.flatMap((a) => a.runs)) {
      if (run.status === "running")
        Object.assign(run, { status: "failed", detail: "The host restarted" });
    }
    this.timer = setInterval(() => void this.pollPullRequests(), PULL_REQUEST_POLL_MS);
    this.timer.unref?.();
    // Catch up soon after the host starts rather than a full interval later.
    this.firstPoll = setTimeout(() => void this.pollPullRequests(), FIRST_POLL_MS);
    this.firstPoll.unref?.();
  }

  /** Reads the store; a file that cannot be read as automations is kept aside, never overwritten. */
  private async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch {
      return; // No automations yet.
    }
    try {
      const raw = JSON.parse(text) as Partial<StoreFile>;
      if (!Array.isArray(raw.automations)) throw new Error("No automations list");
      const now = this.now();
      this.store = {
        version: 1,
        automations: raw.automations,
        pullRequestsSeen: raw.pullRequestsSeen ?? {},
        fires: Object.fromEntries(
          Object.entries(raw.fires ?? {}).map(([id, list]) => [
            id,
            list.filter((f) => now - f.at < DAY_MS),
          ]),
        ),
        driven: Object.fromEntries(
          Object.entries(raw.driven ?? {}).filter(([, until]) => until > now),
        ),
      };
    } catch {
      await fs.rename(this.file, `${this.file}.unreadable-${this.now()}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstPoll) clearTimeout(this.firstPoll);
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  /** Serialises every change to the store. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  find(id: string): Automation | undefined {
    return this.store.automations.find((a) => a.id === id);
  }

  /** Every automation, newest run last; a schedule trigger's history includes its schedule's own runs. */
  async list(): Promise<Automation[]> {
    const out: Automation[] = [];
    for (const automation of this.store.automations) {
      const runs = [...automation.runs, ...(await this.cadenceRuns(automation))]
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-MAX_RUNS_KEPT);
      const lastRunAt = runs[runs.length - 1]?.at;
      out.push({ ...automation, runs, ...(lastRunAt ? { lastRunAt } : {}) });
    }
    return out;
  }

  private async cadenceRuns(automation: Automation): Promise<AutomationRun[]> {
    if (automation.trigger.kind !== "schedule" || !automation.scheduleId) return [];
    try {
      const schedule = await this.deps.schedules.inspect(automation.scheduleId);
      // "Run now" runs are already in the automation's own history.
      const own = new Set(automation.runs.map((r) => r.scheduleRunId).filter(Boolean));
      return scheduleRunsAsAutomationRuns(schedule.runs.filter((r) => !own.has(r.id)));
    } catch {
      return [];
    }
  }

  private async backingSchedule(
    input: AutomationInput,
    existing: string | null,
  ): Promise<string | null> {
    const action = input.action;
    if (action.kind === "note") {
      if (existing) await this.deps.schedules.delete(existing).catch(() => {});
      return null;
    }
    const cadence = input.trigger.kind === "schedule" ? input.trigger.cadence : PAUSED_CADENCE;
    const prompt = renderPrompt(action.prompt, { summary: describeTrigger(input.trigger) });
    const target = await this.targetFor(action);
    // Saving never starts a session: no run on create, and event triggers (or a switched-off automation) are
    // created paused, so there is no active moment for the schedule tick to fire in.
    const created = await this.deps.schedules.create({
      name: `Automation: ${input.name}`,
      prompt,
      cadence,
      target,
      runOnCreate: false,
      paused: input.trigger.kind !== "schedule" || !input.enabled,
    });
    // The old schedule goes only once its replacement exists.
    if (existing) await this.deps.schedules.delete(existing).catch(() => {});
    return created.id;
  }

  private async targetFor(
    action: Exclude<AutomationAction, { kind: "note" }>,
  ): Promise<CreateScheduleInput["target"]> {
    if (action.kind === "message_session") return { type: "agent", agentId: action.agentId };
    const cwd = await this.deps.projectRoot(action.projectId);
    if (!cwd) throw new Error("The automation's project is not on this host");
    return {
      type: "new-agent",
      config: {
        provider: action.provider,
        cwd,
        ...(action.model ? { model: action.model } : {}),
        ...(action.modeId ? { modeId: action.modeId } : {}),
        ...(action.thinkingOptionId ? { thinkingOptionId: action.thinkingOptionId } : {}),
        archiveOnFinish: false,
        title: action.title ?? null,
        // Not unattended unless chosen: the session gets a person's default permission mode and asks first.
        unattended: action.allowUnattended === true,
      },
    };
  }

  /** Refuses what an automation must not do without the person choosing it, before anything is created. */
  private async assertSafe(input: AutomationInput): Promise<void> {
    const action = input.action;
    if (action.kind === "start_session") {
      if (isUnattendedMode(action.provider, action.modeId) && action.allowUnattended !== true) {
        throw new Error(
          "That template runs without asking for permission. Turn on “Run without asking” to use it in an automation.",
        );
      }
      return;
    }
    if (action.kind === "message_session") {
      const agent = await this.deps.projectOfAgent(action.agentId);
      if (!agent || agent.internal || agent.archived) {
        throw new Error("That session can't be messaged by an automation");
      }
    }
  }

  /** A start-session action made from a template takes the template's provider and settings. */
  private withTemplate(input: AutomationInput): AutomationInput {
    const action = input.action;
    if (action.kind !== "start_session" || !action.profileId) return input;
    const profile = this.deps.profile?.(action.profileId);
    if (!profile) throw new Error("That template is no longer on this host");
    const { model: _m, modeId: _o, thinkingOptionId: _t, ...rest } = action;
    return {
      ...input,
      action: {
        ...rest,
        provider: profile.provider,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.modeId ? { modeId: profile.modeId } : {}),
        ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      },
    };
  }

  upsert(request: AutomationInput & { id?: string }): Promise<Automation> {
    return this.exclusive(async () => {
      const input = { ...this.withTemplate(request), id: request.id };
      await this.assertSafe(input);
      const now = new Date(this.now()).toISOString();
      const found = input.id ? this.store.automations.find((a) => a.id === input.id) : undefined;
      if (input.id && !found) throw new Error("No such automation");
      // Editing replaces the backing schedule; keep its runs in the automation's own history first.
      const kept = found
        ? [...found.runs, ...(await this.cadenceRuns(found))].slice(-MAX_RUNS_KEPT)
        : [];
      const scheduleId = await this.backingSchedule(input, found?.scheduleId ?? null);
      const automation: Automation = {
        id: found?.id ?? randomUUID(),
        name: input.name,
        enabled: input.enabled,
        trigger: input.trigger,
        action: input.action,
        scheduleId,
        createdAt: found?.createdAt ?? now,
        updatedAt: now,
        runs: kept,
        ...(found?.skipped ? { skipped: found.skipped } : {}),
      };
      this.store.automations = [
        ...this.store.automations.filter((a) => a.id !== automation.id),
        automation,
      ];
      await this.save();
      return automation;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<Automation> {
    return this.exclusive(async () => {
      const automation = this.store.automations.find((a) => a.id === id);
      if (!automation) throw new Error("No such automation");
      // The schedule changes first, so a failure leaves the automation as it was.
      if (automation.scheduleId && automation.trigger.kind === "schedule") {
        if (enabled) await this.deps.schedules.resume(automation.scheduleId);
        else await this.deps.schedules.pause(automation.scheduleId);
      }
      automation.enabled = enabled;
      automation.updatedAt = new Date(this.now()).toISOString();
      await this.save();
      return automation;
    });
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const automation = this.store.automations.find((a) => a.id === id);
      if (automation?.scheduleId)
        await this.deps.schedules.delete(automation.scheduleId).catch(() => {});
      this.store.automations = this.store.automations.filter((a) => a.id !== id);
      delete this.store.fires[id];
      this.lanes.delete(id);
      await this.save();
    });
  }

  /** Runs an automation now, as its trigger would (used by "Run now" and by triggers). */
  fire(
    id: string,
    event: TriggerEvent,
    options: { manual?: boolean } = {},
  ): Promise<AutomationRun> {
    return this.exclusive(async () => {
      const automation = this.store.automations.find((a) => a.id === id);
      if (!automation) throw new Error("No such automation");
      const now = this.now();
      const run: AutomationRun = {
        id: randomUUID(),
        at: new Date(now).toISOString(),
        trigger: event.summary,
        status: "ok",
        ...(options.manual ? { manual: true } : {}),
        ...(event.pullRequest !== undefined ? { pullRequest: event.pullRequest } : {}),
        ...(event.subject ? { subject: event.subject } : {}),
      };
      const fires = this.store.fires[id] ?? [];
      if (!options.manual) {
        const allowed = mayFire({
          enabled: automation.enabled,
          fires,
          now,
          subject: event.subject,
        });
        if (!allowed) {
          // Counted, not kept: skipped runs never push real runs out of the history.
          automation.skipped = { count: (automation.skipped?.count ?? 0) + 1, lastAt: run.at };
          await this.save();
          return { ...run, status: "skipped" };
        }
        this.store.fires[id] = [
          ...fires.filter((f) => now - f.at < DAY_MS),
          { at: now, ...(event.subject ? { subject: event.subject } : {}) },
        ];
      }
      Object.assign(run, await this.perform(automation, event));
      automation.runs = [...automation.runs, run].slice(-MAX_RUNS_KEPT);
      automation.lastRunAt = run.at;
      await this.save();
      if (run.status === "running" && automation.scheduleId && automation.action.kind !== "note") {
        const prompt = renderPrompt(automation.action.prompt, event);
        this.startScheduleRun({
          automation,
          scheduleId: automation.scheduleId,
          runId: run.id,
          prompt,
        });
      }
      return { ...run };
    });
  }

  private async perform(
    automation: Automation,
    event: TriggerEvent,
  ): Promise<Partial<AutomationRun>> {
    const action = automation.action;
    try {
      if (action.kind === "note") return await this.recordNote(automation, event);
      if (!automation.scheduleId)
        return { status: "failed", detail: "The automation has no schedule" };
      return { status: "running" };
    } catch (error) {
      return { status: "failed", detail: errorText(error) };
    }
  }

  /**
   * Runs the backing schedule once with this event's prompt. A run lasts as long as the session's turn, so it finishes
   * outside the store queue; an automation's runs go one after another, each setting its own prompt just before it starts.
   */
  private startScheduleRun(input: {
    automation: Automation;
    scheduleId: string;
    runId: string;
    prompt: string;
  }): void {
    const { automation, scheduleId, runId, prompt } = input;
    const finish = (outcome: Partial<AutomationRun>) =>
      this.exclusive(async () => {
        const run = this.store.automations
          .find((a) => a.id === automation.id)
          ?.runs.find((r) => r.id === runId);
        if (!run) return;
        Object.assign(run, outcome);
        if (!run.detail) delete run.detail;
        if (outcome.agentId) await this.drive(outcome.agentId);
        else await this.save();
      }).catch(() => {});
    const previous = this.lanes.get(automation.id);
    const lane = this.afterLane(previous, async () => {
      try {
        await this.deps.schedules.update({ id: scheduleId, prompt });
        // Just before the message goes: the session it lands in cannot trigger session automations for a while.
        const action = automation.action;
        if (action.kind === "message_session")
          await this.exclusive(() => this.drive(action.agentId));
      } catch (error) {
        await finish({ status: "failed", detail: errorText(error) });
        return;
      }
      await finish(await this.awaitScheduleRun(scheduleId));
    });
    this.lanes.set(automation.id, lane);
  }

  /** Runs work once the automation's previous run (if any) has finished. Neither ever rejects. */
  private async afterLane(previous: Promise<void> | undefined, work: () => Promise<void>) {
    if (previous) await previous;
    await work();
  }

  private async awaitScheduleRun(scheduleId: string): Promise<Partial<AutomationRun>> {
    try {
      const schedule = await this.deps.schedules.runOnce(scheduleId);
      const last = schedule.runs[schedule.runs.length - 1];
      if (last?.status === "failed") {
        return {
          status: "failed",
          scheduleRunId: last.id,
          detail: last.error ?? "The session did not start",
        };
      }
      return {
        status: "ok",
        ...(last ? { scheduleRunId: last.id } : {}),
        ...(last?.agentId ? { agentId: last.agentId } : {}),
      };
    } catch (error) {
      return { status: "failed", detail: errorText(error) };
    }
  }

  /** Sessions an automation started or messaged do not trigger session automations for a while (persisted). */
  private async drive(agentId: string): Promise<void> {
    this.store.driven[agentId] = this.now() + DRIVEN_MS;
    await this.save();
  }

  private isDriven(agentId: string): boolean {
    const until = this.store.driven[agentId];
    if (until === undefined) return false;
    if (until > this.now()) return true;
    delete this.store.driven[agentId];
    return false;
  }

  private async recordNote(
    automation: Automation,
    event: TriggerEvent,
  ): Promise<Partial<AutomationRun>> {
    if (automation.action.kind !== "note") return { status: "failed" };
    const text = automation.action.text.replaceAll("{{event}}", event.summary);
    const file = path.join(this.deps.paseoHome, "automations", "notes.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = {
      at: new Date(this.now()).toISOString(),
      automationId: automation.id,
      text,
      event: event.summary,
    };
    await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    // Opt-in only: post the note to the pull request that triggered it.
    if (automation.action.postToGithub && event.pullRequest !== undefined && event.projectId) {
      const cwd = await this.deps.projectRoot(event.projectId);
      if (cwd) {
        await this.deps.runGh(["pr", "comment", String(event.pullRequest), "--body", text], {
          cwd,
        });
        return { status: "ok", detail: text.slice(0, 300), posted: true };
      }
    }
    return { status: "ok", detail: text.slice(0, 300) };
  }

  /** Session triggers, from agent manager events. Sessions started by automations never trigger. */
  async onAgentEvent(input: Parameters<typeof sessionEventOf>[0]): Promise<void> {
    const kind = sessionEventOf(input);
    if (!kind || !input.agentId) return;
    const watching = this.store.automations.filter(
      (a) => a.enabled && a.trigger.kind === "session" && a.trigger.event === kind,
    );
    if (watching.length === 0) return;
    if (this.isDriven(input.agentId)) return;
    const agent = await this.deps.projectOfAgent(input.agentId);
    // Sessions a schedule started (including every automation's) never trigger session automations.
    if (!agent || agent.labels["paseo.schedule-id"]) return;
    for (const automation of watching) {
      if (automation.trigger.kind !== "session") continue;
      if (automation.trigger.projectId && automation.trigger.projectId !== agent.projectId)
        continue;
      const summary = `session ${kind.replace("_", " ")}`;
      await this.fire(automation.id, {
        summary,
        subject: `session:${input.agentId}`,
        projectId: agent.projectId,
      }).catch(() => {});
    }
  }

  /** Pull request triggers: new numbers are "opened"; a changed head or update time is "updated". */
  async pollPullRequests(): Promise<void> {
    const watching = this.store.automations.filter(
      (a) => a.enabled && a.trigger.kind === "pull_request",
    );
    const projects = [
      ...new Set(
        watching.map((a) => (a.trigger.kind === "pull_request" ? a.trigger.projectId : "")),
      ),
    ];
    for (const projectId of projects.filter(Boolean)) {
      const cwd = await this.deps.projectRoot(projectId);
      if (!cwd) continue;
      // Numbers and head commits only: a pull request's title and body never reach an automation's prompt.
      let rows: { number: number; headRefOid?: string }[] = [];
      try {
        const out = await this.deps.runGh(
          ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefOid"],
          { cwd },
        );
        rows = JSON.parse(out.stdout);
      } catch {
        continue;
      }
      const seen = this.store.pullRequestsSeen[projectId];
      const next: Record<string, string> = {};
      for (const row of rows) next[String(row.number)] = row.headRefOid ?? "";
      this.store.pullRequestsSeen[projectId] = next;
      // The first poll only learns what is already open.
      if (!seen) continue;
      for (const row of rows) {
        const key = String(row.number);
        const change = changeOf(seen[key], next[key]);
        if (!change) continue;
        for (const automation of watching) {
          if (
            automation.trigger.kind !== "pull_request" ||
            automation.trigger.projectId !== projectId
          )
            continue;
          if (!automation.trigger.events.includes(change)) continue;
          await this.fire(automation.id, {
            summary: `pull request #${row.number} ${change}`,
            subject: `pull-request:${row.number}`,
            projectId,
            pullRequest: row.number,
          }).catch(() => {});
        }
      }
    }
    await this.exclusive(() => this.save()).catch(() => {});
  }
}

export type AutomationRequest =
  | AutomationListRequest
  | AutomationSaveRequest
  | AutomationSetEnabledRequest
  | AutomationDeleteRequest
  | AutomationRunNowRequest;

/** Applies one automation RPC; "Run now" returns the run it started. */
export async function applyAutomationRequest(
  service: AutomationService,
  msg: AutomationRequest,
): Promise<AutomationRun | null> {
  switch (msg.type) {
    case "automation.list.request":
      return null;
    case "automation.save.request":
      await service.upsert({ ...msg.automation, ...(msg.id ? { id: msg.id } : {}) });
      return null;
    case "automation.set-enabled.request":
      await service.setEnabled(msg.id, msg.enabled);
      return null;
    case "automation.delete.request":
      await service.remove(msg.id);
      return null;
    case "automation.run-now.request": {
      const automation = service.find(msg.id);
      if (!automation) throw new Error("No such automation");
      return service.fire(
        msg.id,
        { summary: describeTrigger(automation.trigger) },
        { manual: true },
      );
    }
  }
}

// The host's one automation service, set at startup; client sessions read it for the automation RPCs.
let hostAutomations: AutomationService | null = null;

export function setHostAutomations(service: AutomationService | null): void {
  hostAutomations = service;
}

export function getHostAutomations(): AutomationService {
  if (!hostAutomations) throw new Error("Automations are not running on this host");
  return hostAutomations;
}

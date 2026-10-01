import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-background-work";

/**
 * Background jobs Claude Code has left running, read from its own task protocol (MULTIHOST-DESIGN §6.1).
 *
 * Verified on the wire alongside the subagent source (subagents/live-source.ts):
 *
 *   task_started       task_id, task_type ("local_bash" = backgrounded shell, "local_workflow",
 *                      "local_agent" = Task subagent), skip_transcript
 *   task_updated       task_id, patch.status, patch.is_backgrounded
 *   task_notification  task_id, status (any status closes the task)
 *
 * Subagents are not counted: they already make their parent "running" while they run. Housekeeping
 * tasks (`skip_transcript`) are not the user's work. Everything here is display only; the count may
 * make a workspace look busy, and nothing may gate an action on it.
 */
type Kind = "shell" | "workflow";

interface OpenTask {
  kind: Kind;
  startedAt: Date;
  /** A backgrounded task outlives the turn that started it; a foreground one dies with it. */
  backgrounded: boolean;
}

const KIND_BY_TASK_TYPE = new Map<string, Kind>([
  ["local_bash", "shell"],
  ["local_workflow", "workflow"],
]);

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "killed",
  "canceled",
  "cancelled",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class ClaudeBackgroundWorkTracker {
  private readonly open = new Map<string, OpenTask>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Feeds one SDK message; returns true when the count or kinds changed. */
  observe(message: unknown): boolean {
    const m = record(message);
    if (!m || m.type !== "system") return false;
    const taskId = text(m.task_id);
    if (!taskId) return false;
    switch (m.subtype) {
      case "task_started":
        return this.started(taskId, m);
      case "task_updated":
        return this.updated(taskId, record(m.patch));
      case "task_notification":
        return this.open.delete(taskId);
      default:
        return false;
    }
  }

  /** A canceled turn takes its foreground tasks with it; backgrounded ones carry on. */
  cancelForeground(): boolean {
    let changed = false;
    for (const [taskId, task] of this.open) {
      if (task.backgrounded) continue;
      this.open.delete(taskId);
      changed = true;
    }
    return changed;
  }

  /** The Claude process exited or the session closed: every job it owned ended with it. */
  clear(): boolean {
    const changed = this.open.size > 0;
    this.open.clear();
    return changed;
  }

  snapshot(): AgentBackgroundWork | null {
    if (this.open.size === 0) return null;
    const tasks = [...this.open.values()];
    const kinds = (["shell", "workflow"] as const).filter((kind) =>
      tasks.some((t) => t.kind === kind),
    );
    const oldest = Math.min(...tasks.map((t) => t.startedAt.getTime()));
    return {
      count: Math.min(tasks.length, 999),
      kinds,
      source: "provider",
      since: new Date(oldest).toISOString(),
      observedAt: this.now().toISOString(),
    };
  }

  private started(taskId: string, m: Record<string, unknown>): boolean {
    if (m.skip_transcript === true) return false;
    const kind = typeof m.task_type === "string" ? KIND_BY_TASK_TYPE.get(m.task_type) : undefined;
    if (!kind || this.open.has(taskId)) return false;
    this.open.set(taskId, { kind, startedAt: this.now(), backgrounded: kind === "shell" });
    return true;
  }

  private updated(taskId: string, patch: Record<string, unknown> | null): boolean {
    const task = this.open.get(taskId);
    if (!task || !patch) return false;
    const status = text(patch.status);
    if (status && TERMINAL_STATUSES.has(status)) return this.open.delete(taskId);
    if (patch.is_backgrounded === true) task.backgrounded = true;
    return false;
  }
}

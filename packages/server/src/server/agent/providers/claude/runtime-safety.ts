import type { SDKMessage, SessionCronSummary } from "@anthropic-ai/claude-agent-sdk";
import { parseClaudeCodeVersion } from "./model-manifest.js";

const SESSION_CRON_TOOLS = new Set(["CronCreate", "CronDelete", "ScheduleWakeup"]);

/** Process-local background ownership. Completion delivery can follow an empty roster. */
export class ClaudeRuntimeSafety {
  private supported = false;
  private liveTasks = new Set<string>();
  private readonly awaitingNotifications = new Set<string>();
  // Background work starts inside a turn, and init only arrives with a turn. A process that
  // has neither been sent a prompt nor reported init (a resumed chat that only answered
  // control requests) owns no background work.
  private turnSeen = false;
  // Session-only crons and wakeups live in the process and die with it. Only the Stop hook
  // lists them, and Claude runs it only for turns that complete. A cron tool call makes the
  // count unknown until the next Stop, so an interrupted or failed turn keeps the runtime.
  private sessionCrons = 0;
  private sessionCronsUnknown = false;

  reset(): void {
    this.sessionCrons = 0;
    this.sessionCronsUnknown = false;
    this.supported = false;
    this.turnSeen = false;
    this.liveTasks.clear();
    this.awaitingNotifications.clear();
  }

  /** Called before a prompt is written to this process. */
  notePromptSent(): void {
    this.turnSeen = true;
  }

  /** Called with the session crons of each main-thread Stop hook. Older CLIs omit them. */
  observeStop(sessionCrons: readonly SessionCronSummary[] | undefined): void {
    this.sessionCronsUnknown = false;
    if (sessionCrons) this.sessionCrons = sessionCrons.length;
  }

  observe(message: SDKMessage): void {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && SESSION_CRON_TOOLS.has(block.name))
          this.sessionCronsUnknown = true;
      }
      return;
    }
    if (message.type !== "system") return;
    if (message.subtype === "init") {
      this.turnSeen = true;
      // 2.1.292 is a known roster-capable release. Older binaries can demonstrate
      // support by sending a roster; a fresh process starts with an empty roster.
      const version = parseClaudeCodeVersion(message.claude_code_version ?? "");
      if (
        version &&
        (version[0] > 2 ||
          (version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 292))))
      )
        this.supported = true;
    }
    if (message.subtype === "background_tasks_changed") {
      this.supported = true;
      this.liveTasks = new Set(message.tasks.map((task) => task.task_id));
      for (const id of this.liveTasks) this.awaitingNotifications.add(id);
    }
    if (message.subtype === "task_notification") {
      this.awaitingNotifications.delete(message.task_id);
    }
  }

  canStopRuntime(): boolean {
    if (!this.supported && !this.turnSeen) return true;
    return (
      this.supported &&
      this.sessionCrons === 0 &&
      !this.sessionCronsUnknown &&
      this.liveTasks.size === 0 &&
      this.awaitingNotifications.size === 0
    );
  }
}

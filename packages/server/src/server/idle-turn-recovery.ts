import { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL } from "@getpaseo/protocol/limit-resume";
import type { Logger } from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import { FINAL_INPUT_CHECK, type AgentTimelineItem } from "./agent/agent-sdk-types.js";
import {
  createFinalInputCheck,
  FinalInputWithdrawnError,
  waitForFinalInputHandoff,
} from "./agent/final-input-check.js";
import { finishNoticeWanted } from "./finish-notice-filter.js";

export const IDLE_TURN_PROMPT = "check your background job output now and finish in the foreground";

/** Only the latest turn counts. A result from an older turn cannot close current work. */
export function unfinishedIdleTurn(
  items: readonly AgentTimelineItem[],
): { retried: boolean } | null {
  const start = items.findLastIndex((item) => item.type === "user_message");
  const turn = items.slice(start + 1);
  if (turn.some((item) => item.type === "assistant_message" && finishNoticeWanted(item.text)))
    return null;
  const last = turn.findLast(
    (item) =>
      item.type === "tool_call" ||
      (item.type === "assistant_message" && item.text.trim().length > 0),
  );
  const waiting =
    last?.type === "assistant_message" &&
    /\b(?:I(?:['’]ll| will)\s+wait|waiting)\s+(?:for|until)\b[^\n]{0,300}\b(?:background|job|notice|notification|callback|worker|subagent)\b/i.test(
      last.text,
    );
  if (last?.type !== "tool_call" && !waiting) return null;
  const user = items[start];
  return { retried: user?.type === "user_message" && user.text.trim() === IDLE_TURN_PROMPT };
}

export class IdleTurnRecovery {
  private readonly handled = new Map<string, string>();

  constructor(
    private readonly deps: {
      agentManager: AgentManager;
      logger: Logger;
      stopped: () => boolean;
      blocked: (id: string, reason: string) => Promise<void>;
    },
  ) {}

  /** One action per observed idle turn. The recovery prompt in history prevents a second continuation. */
  async handle(id: string): Promise<boolean> {
    // A terminal event precedes the manager's run cleanup. Let that cleanup finish first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const { agentManager: manager } = this.deps;
    const live = manager.getAgent(id);
    if (
      this.deps.stopped() ||
      !live ||
      live.internal ||
      live.archivedAt ||
      live.lifecycle !== "idle"
    )
      return false;
    const items = manager.getTimeline?.(id) ?? [];
    const unfinished = unfinishedIdleTurn(items);
    if (!unfinished) return false;
    const stamp = JSON.stringify([live.instanceId, live.lastUserMessageAt, items.length]);
    if (this.handled.get(id) === stamp) return true;
    this.handled.set(id, stamp);
    if (unfinished.retried) {
      await this.deps.blocked(
        id,
        "the session stopped unfinished again after one automatic continuation",
      );
      return true;
    }
    try {
      await this.continueOne(id);
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId: id }, "Idle turn continuation refused");
      await this.deps.blocked(id, "the unfinished idle turn could not be continued safely");
    }
    return true;
  }

  private async continueOne(id: string): Promise<void> {
    const { agentManager: manager } = this.deps;
    const live = manager.getAgent(id);
    if (!live || manager.hasInFlightRun(id)) throw new Error("Session is busy or missing");
    const cutAt = live.lastUserMessageAt?.toISOString() ?? null;
    const instanceId = live.instanceId;
    const check = () => {
      const current = manager.getAgent(id);
      if (
        this.deps.stopped() ||
        !current ||
        current.instanceId !== instanceId ||
        current.archivedAt ||
        (current.lastUserMessageAt?.toISOString() ?? null) !== cutAt ||
        !manager.canRunUnscopedLimitResume(id) ||
        manager.getPendingPermissions(id).length > 0 ||
        ["paused", "blocked", "done"].includes(current.labels["fulcra.hold"]) ||
        current.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off" ||
        Date.parse(current.labels[LIMIT_RESUME_AT_LABEL] ?? "") > Date.now()
      )
        throw new FinalInputWithdrawnError(
          "Idle turn recovery refused",
          "session safety check changed",
        );
    };
    check();
    const finalCheck = createFinalInputCheck(check);
    void manager
      .runAgent(id, IDLE_TURN_PROMPT, { [FINAL_INPUT_CHECK]: finalCheck })
      .catch((error) => {
        this.deps.logger.warn({ err: error, agentId: id }, "Idle turn continuation failed");
      });
    await waitForFinalInputHandoff(finalCheck);
  }
}

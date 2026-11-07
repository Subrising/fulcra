/**
 * FU-736: the prompt that starts a turn, as the timeline shows it. Paseo v0.15.0 shows a `<paseo-system>` prompt as a
 * "heartbeat" tool call (callId `paseo-system:`, the submitted id in metadata) and a chat's message as an
 * "agent_message" tool call. Before this check knew those shapes, no notice turn was seen as one, and a worker whose
 * lead is on another computer got a new notice after every notice turn (about 7,750 turns on one worker).
 */
function promptProvenance(item, isSystemInjectedEnvelope) {
  if (item?.type === "user_message") {
    const text = typeof item.text === "string" ? item.text : "";
    return {
      system: isSystemInjectedEnvelope(text),
      messageId: typeof item.clientMessageId === "string" ? item.clientMessageId : "",
    };
  }
  if (item?.type !== "tool_call" || typeof item.callId !== "string") return null;
  if (item.callId.startsWith("paseo-system:")) {
    const submitted = item.metadata?.submittedMessageId;
    return { system: true, messageId: typeof submitted === "string" ? submitted : "" };
  }
  if (item.callId.startsWith("paseo-agent-message:")) return { system: false, messageId: "" };
  return null;
}

/** Native observations select notices. The host checks ownership and dispatches them. */
export class ReportUpObserver {
  turns = new Map();
  permissions = new Map();
  stopped = false;

  constructor(deps) {
    this.deps = deps;
  }

  isOpen(id) {
    return this.turns.get(id)?.open === true;
  }

  turnStarted(id) {
    if (this.stopped) return;
    const turn = this.turns.get(id) ?? { fromNotice: null };
    turn.open = true;
    turn.startedAt = this.deps.now();
    this.turns.set(id, turn);
    this.deps.onStarted(id);
  }

  firstMessage(id, item) {
    if (this.stopped) return;
    const provenance = promptProvenance(item, this.deps.isSystemInjectedEnvelope);
    if (!provenance) return;
    const turn = this.turns.get(id) ?? { open: false, fromNotice: null };
    if (turn.fromNotice !== null) return;
    const { messageId } = provenance;
    turn.open = true;
    turn.startedAt ??= this.deps.now();
    turn.fromNotice = provenance.system || messageId.startsWith(this.deps.noticePrefix);
    turn.fromNudge = messageId.startsWith(`${this.deps.noticePrefix}idle-nudge:`);
    this.turns.set(id, turn);
  }

  turnEnded(id, kind, failure = "", lastAssistant) {
    if (this.stopped) return;
    const turn = this.turns.get(id);
    if (!turn?.open) return;
    const input = {
      agentId: id,
      failed: kind === "failed",
      fromNotice: turn.fromNotice === true,
      fromNudge: turn.fromNudge === true,
      startedAt: turn.startedAt,
      failure,
      lastAssistant,
    };
    turn.open = false;
    turn.fromNotice = null;
    turn.fromNudge = false;
    turn.startedAt = undefined;
    // Capture the host's finish owner synchronously, before delivery callbacks can remove it.
    if (kind !== "canceled") this.deps.onEnded(input);
  }

  permissionRequested(id, request) {
    if (this.stopped || !request?.id) return;
    const key = `${id}:${request.id}`;
    if (this.permissions.has(key)) return;
    this.permissions.set(key, request);
    this.deps.onPermission(id, request);
  }

  hasPermission(id, request) {
    return !this.stopped && this.permissions.get(`${id}:${request.id}`) === request;
  }

  permissionResolved(id, requestId) {
    this.permissions.delete(`${id}:${requestId}`);
  }

  close(id) {
    this.turns.delete(id);
    for (const key of this.permissions.keys())
      if (key.startsWith(`${id}:`)) this.permissions.delete(key);
    this.deps.onClosed?.(id);
  }

  stop() {
    this.stopped = true;
    this.turns.clear();
    this.permissions.clear();
  }

  /** Adapter for host timeline provenance and existing stream fixtures. */
  onStream(id, event) {
    if (event.type === "timeline") this.firstMessage(id, event.item);
    else if (event.type === "turn_started") this.turnStarted(id);
    else if (event.type === "permission_requested") this.permissionRequested(id, event.request);
    else if (event.type === "permission_resolved") this.permissionResolved(id, event.requestId);
    else if (["turn_completed", "turn_failed", "turn_canceled"].includes(event.type)) {
      const outcomes = {
        turn_failed: "failed",
        turn_canceled: "canceled",
        turn_completed: "completed",
      };
      const kind = outcomes[event.type];
      const failure = [event.error, event.code, event.diagnostic]
        .filter((part) => part !== undefined && part !== null)
        .map(String)
        .join(" ");
      this.turnEnded(id, kind, failure);
    }
  }
}

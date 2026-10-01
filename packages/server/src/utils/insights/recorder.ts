import { promises as fs } from "node:fs";
import path from "node:path";
import { USAGE_LIMIT, type AgentEvent } from "./agents.js";

// The insights event log: the few agent events the host does not keep anywhere else. A session asking for a
// permission (blocked on the person), that permission being answered, and a turn failing on a usage limit. One
// JSON line per event under $PASEO_HOME/insights/, rotated at MAX_BYTES; the first line says when recording began.
// Nothing here changes an agent; it only listens.

const MAX_BYTES = 5 * 1024 * 1024;

export const insightsLogPath = (paseoHome: string) =>
  path.join(paseoHome, "insights", "agent-events.jsonl");

/** The minimum of the agent manager's event shape this recorder reads. */
export interface RecordableAgentEvent {
  type: string;
  agentId?: string;
  event?: { type?: string; error?: unknown; code?: unknown };
}

/** The log line for one agent manager event, or null when the insights don't need it. */
export function eventFor(input: RecordableAgentEvent, at: string): AgentEvent | null {
  if (input.type !== "agent_stream" || !input.agentId || !input.event) return null;
  const kind = input.event.type;
  if (kind === "permission_requested") return { type: "blocked", agentId: input.agentId, at };
  if (kind === "permission_resolved") return { type: "unblocked", agentId: input.agentId, at };
  if (kind === "turn_failed") {
    const text = `${String(input.event.error ?? "")} ${String(input.event.code ?? "")}`;
    if (USAGE_LIMIT.test(text)) return { type: "limit", agentId: input.agentId, at };
  }
  return null;
}

export class InsightsRecorder {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly paseoHome: string) {}

  /** Marks when recording began, once per log. */
  async start(): Promise<void> {
    const file = insightsLogPath(this.paseoHome);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.access(file);
    } catch {
      await fs.appendFile(
        file,
        `${JSON.stringify({ type: "recording-started", at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    }
  }

  record(input: RecordableAgentEvent): void {
    const line = eventFor(input, new Date().toISOString());
    if (!line) return;
    this.queue = this.queue.then(() => this.append(line)).catch(() => {});
  }

  private async append(line: AgentEvent): Promise<void> {
    const file = insightsLogPath(this.paseoHome);
    try {
      const { size } = await fs.stat(file);
      if (size > MAX_BYTES) await fs.rename(file, `${file}.1`);
    } catch {
      // No log yet: the append below creates it.
    }
    await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
}

/** Every event in the log (current and rotated); unreadable lines are skipped. */
export async function readInsightsEvents(paseoHome: string): Promise<AgentEvent[]> {
  const file = insightsLogPath(paseoHome);
  const events: AgentEvent[] = [];
  for (const candidate of [`${file}.1`, file]) {
    let text = "";
    try {
      text = await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const e = JSON.parse(line) as AgentEvent;
        if (typeof e?.type === "string" && typeof e.at === "string") events.push(e);
      } catch {
        // partial or blank line
      }
    }
  }
  return events;
}

/** Starts recording for this host: listens to agent events and appends what insights need. Never throws. */
export async function startInsightsRecorder(input: {
  paseoHome: string;
  subscribe: (listener: (event: RecordableAgentEvent) => void) => unknown;
  onError: (error: unknown) => void;
}): Promise<void> {
  const recorder = new InsightsRecorder(input.paseoHome);
  try {
    await recorder.start();
    input.subscribe((event) => recorder.record(event));
  } catch (error) {
    input.onError(error);
  }
}

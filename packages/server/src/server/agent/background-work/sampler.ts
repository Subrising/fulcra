import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-background-work";
import {
  countShellJobs,
  readProcessTable,
  toBackgroundWork,
  type ReadProcessTable,
} from "./process-tree.js";

export interface BackgroundWorkTarget {
  agentId: string;
  /** The provider process, or null when the session has none. */
  pid: number | null;
  /** Only idle agents are sampled: while a turn runs, its own commands are foreground. */
  idle: boolean;
}

export interface BackgroundWorkSamplerOptions {
  listTargets: () => BackgroundWorkTarget[];
  onChange: (agentId: string, work: AgentBackgroundWork | null) => void;
  readTable?: ReadProcessTable;
  now?: () => Date;
  intervalMs?: number;
}

/**
 * Samples the process table for providers without a task protocol (display only). One `ps` per tick,
 * and none at all while no idle agent has a provider process.
 */
export class BackgroundWorkSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly last = new Map<string, number>();
  private readonly readTable: ReadProcessTable;
  private readonly now: () => Date;

  constructor(private readonly options: BackgroundWorkSamplerOptions) {
    this.readTable = options.readTable ?? readProcessTable;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 5_000);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sample. Public for tests. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const targets = this.options.listTargets();
      const sampled = targets.filter((t) => t.idle && t.pid !== null);
      const rows = sampled.length > 0 ? await this.readTable() : [];
      const now = this.now();
      const seen = new Set<string>();
      for (const target of targets) {
        seen.add(target.agentId);
        const jobs =
          target.idle && target.pid !== null
            ? countShellJobs(rows, target.pid)
            : { count: 0, oldestElapsedSeconds: null };
        this.report(target.agentId, jobs.count, toBackgroundWork(jobs, now));
      }
      // An agent that went away has no jobs left to show.
      for (const agentId of this.last.keys()) {
        if (!seen.has(agentId)) this.report(agentId, 0, null);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private report(agentId: string, count: number, work: AgentBackgroundWork | null): void {
    const previous = this.last.get(agentId) ?? 0;
    if (count === previous) return;
    if (count === 0) this.last.delete(agentId);
    else this.last.set(agentId, count);
    this.options.onChange(agentId, work);
  }
}

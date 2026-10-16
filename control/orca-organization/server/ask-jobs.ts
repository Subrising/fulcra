import { randomUUID } from "node:crypto";

// Fulcra 0.2.17 (FU-58): the controller answers a plugin call within 30 s, and a model call can take longer, so `fulcra
// ask` starts a job and reads its result by id. Jobs live in memory only: a daemon restart ends them, and the caller
// asks again. askOnce persists secret-free billing failures before rejecting. At most MAX_RUNNING run at once; finished jobs are dropped after KEEP_MS.

export interface AskResult {
  output: unknown;
  account: string;
  model: string;
  costUsd: number | null;
}
export interface AskJobView {
  state: "running" | "done" | "failed";
  result?: AskResult;
  error?: { code: string; message: string };
}
interface Job extends AskJobView {
  at: number;
}

export const MAX_RUNNING_ASKS = 4;
export const KEEP_ASK_JOBS_MS = 15 * 60_000;
const MAX_JOBS = 100;

export function createAskJobs<I>(deps: {
  run: (input: I) => Promise<AskResult>;
  now?: () => number;
}) {
  const jobs = new Map<string, Job>();
  const now = deps.now ?? Date.now;
  const prune = () => {
    const limit = now() - KEEP_ASK_JOBS_MS;
    for (const [id, job] of jobs) if (job.state !== "running" && job.at < limit) jobs.delete(id);
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs].find(([, job]) => job.state !== "running");
      if (!oldest) break;
      jobs.delete(oldest[0]);
    }
  };
  return {
    start(input: I): { id: string } {
      prune();
      if ([...jobs.values()].filter((job) => job.state === "running").length >= MAX_RUNNING_ASKS)
        throw new Error("Too many asks are running; try again soon");
      const id = randomUUID();
      const job: Job = { state: "running", at: now() };
      jobs.set(id, job);
      deps.run(input).then(
        (result) => Object.assign(job, { state: "done", result, at: now() }),
        (error: unknown) => {
          const e = error as { code?: unknown; message?: unknown };
          Object.assign(job, {
            state: "failed",
            error: {
              code: typeof e?.code === "string" ? e.code.slice(0, 40) : "ASK_FAILED",
              message: String(e?.message ?? "The ask failed").slice(0, 1000),
            },
            at: now(),
          });
        },
      );
      return { id };
    },
    result(id: string): AskJobView {
      const job = jobs.get(id);
      if (!job)
        return {
          state: "failed",
          error: { code: "UNKNOWN_JOB", message: "No such ask (the daemon may have restarted)" },
        };
      const { at: _at, ...view } = job;
      return view;
    },
  };
}

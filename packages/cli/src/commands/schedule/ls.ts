import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  connectScheduleClient,
  toScheduleCommandError,
  toScheduleRow,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

/** By default only schedules that start a new agent; `--all` adds heartbeats and every other target. */
export function listedSchedules<T extends { target: { type: string } }>(
  schedules: T[],
  all: boolean,
): T[] {
  return all ? schedules : schedules.filter((schedule) => schedule.target.type === "new-agent");
}

export async function runLsCommand(
  options: ScheduleCommandOptions & { all?: boolean },
  _command: Command,
): Promise<ListResult<ScheduleRow>> {
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    const payload = await client.scheduleList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: listedSchedules(payload.schedules, options.all === true).map(toScheduleRow),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_LIST_FAILED", "list schedules", error);
  } finally {
    await client.close().catch(() => {});
  }
}

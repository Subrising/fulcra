import { Command } from "commander";
import { readLeadEvents } from "@getpaseo/server/lead-events";
import { addJsonOption, addLocalDaemonOptions } from "../utils/command-options.js";
import { withOutput, type CommandOptions } from "../output/index.js";

export function createUsageCommand(): Command {
  const command = new Command("usage").description(
    "Read local daemon event counts and routine event digests",
  );
  addJsonOption(
    addLocalDaemonOptions(
      command
        .command("events")
        .description("Read accepted turns by cause; includes durable digests")
        .option("--agent <id>", "Select one session, such as the lead"),
    ),
  ).action(
    withOutput(async (options: CommandOptions & { agent?: string }, _command: Command) => {
      if (options.daemonTarget.kind !== "instance")
        throw new Error("Event counts require a local daemon home.");
      const state = readLeadEvents(options.daemonTarget.home);
      const sessions = Object.entries(state.sessions)
        .filter(([id]) => !options.agent || id === options.agent)
        .map(([id, session]) => ({ id, turns: session.turns, digest: session.digest }));
      return {
        type: "list" as const,
        data: sessions,
        schema: {
          idField: "id" as const,
          columns: [
            { header: "SESSION", field: "id" as const },
            {
              header: "TURNS",
              field: (session: (typeof sessions)[number]) =>
                Object.values(session.turns).reduce((a, b) => a + b, 0),
            },
            {
              header: "DIGEST",
              field: (session: (typeof sessions)[number]) => session.digest.length,
            },
          ],
          renderHuman: () =>
            sessions
              .map((session) =>
                [
                  session.id,
                  ...Object.entries(session.turns).map(([kind, count]) => `  ${kind}: ${count}`),
                  ...session.digest.map(
                    (event) =>
                      `  ${event.at} ${event.kind} ${event.sourceId} ${event.eventId}: ${event.reason}`,
                  ),
                ].join("\n"),
              )
              .join("\n\n"),
        },
      };
    }),
  );
  return command;
}

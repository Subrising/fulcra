import { Command } from "commander";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { controllerPluginIdFromTrustedReports } from "@getpaseo/protocol/bundled-controller";
import { connectToDaemon } from "../utils/client.js";
import { addDaemonHostOption, withGlobalOptions } from "../utils/command-options.js";
import { parseDuration } from "../utils/duration.js";
import type { DaemonTarget } from "../utils/daemon-target.js";
import { loadOutputSchema } from "./agent/run.js";

// Fulcra 0.2.17 (FU-58): `fulcra ask`, a one-shot model call for apps. No tools, no agent, no workspace, no session
// record: the controller runs the Claude CLI once on a pooled account and returns the answer. A usage limit marks that
// account limited and the call moves once to the next usable account. The answer is JSON on stdout.

/** The model when --model is not given. */
export const DEFAULT_ASK_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ASK_TIMEOUT = "120s";
const POLL_MS = 1000;
/** The host's own bound is --timeout for the whole ask; this margin covers its start-up and the polling. */
const WAIT_MARGIN_MS = 30_000;

const started = z.object({ id: z.string() });
const polled = z.object({
  state: z.enum(["running", "done", "failed"]),
  result: z
    .object({
      output: z.unknown(),
      account: z.string(),
      model: z.string(),
      costUsd: z.number().nullable(),
    })
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type AskResult = NonNullable<z.infer<typeof polled>["result"]>;

export interface AskClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  getPluginCatalog?(): Promise<{
    trustedPlugins?: readonly { id: string; contract?: "1.1"; hooks: readonly string[] }[];
  }>;
}

export interface AskInput {
  prompt: string;
  model: string;
  schema?: Record<string, unknown>;
  account?: string;
  timeoutMs: number;
}

export class AskCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AskCommandError";
  }
}

/** Starts the call on the host and waits for its result. Fails with the host's code and message. */
export async function runAsk(
  client: AskClient,
  input: AskInput,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<AskResult> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  // One deadline for the whole ask, measured from here: the host gives the call --timeout in total (a retry on the next
  // account gets what is left), and this margin covers the start-up and the polling.
  const startedAt = now();
  const catalog = await client.getPluginCatalog?.().catch(() => undefined);
  const plugin = controllerPluginIdFromTrustedReports(catalog?.trustedPlugins);
  const { id } = started.parse(
    await client.invokePluginRpc(plugin, "organization.ask.start", {
      prompt: input.prompt,
      model: input.model,
      ...(input.schema ? { schema: input.schema } : {}),
      ...(input.account ? { account: input.account } : {}),
      timeoutMs: input.timeoutMs,
    }),
  );
  const deadline = startedAt + input.timeoutMs + WAIT_MARGIN_MS;
  for (;;) {
    await sleep(POLL_MS);
    const view = polled.parse(
      await client.invokePluginRpc(plugin, "organization.ask.result", { id }),
    );
    if (view.state === "done" && view.result) return view.result;
    if (view.state === "failed")
      throw new AskCommandError(
        view.error?.code ?? "ASK_FAILED",
        view.error?.message ?? "The ask failed",
      );
    if (now() > deadline) throw new AskCommandError("TIMEOUT", "The ask did not finish in time");
  }
}

async function readPrompt(argument: string | undefined): Promise<string> {
  if (argument !== undefined && argument !== "-") return argument;
  // No argument, or "-": the prompt is read from standard input.
  return readFileSync(0, "utf8");
}

interface AskOptions {
  model: string;
  outputSchema?: string;
  timeout: string;
  account?: string;
  daemonTarget: DaemonTarget;
}

export function createAskCommand(): Command {
  const cmd = new Command("ask")
    .description("One-shot model call on a pooled account: no tools, no agent or workspace record")
    .argument(
      "[prompt]",
      'The prompt, or "-" (or nothing) to read it from standard input. On Windows, send the prompt on standard input: cmd.exe changes & | < > ^ % and " in an argument',
    )
    .option("--model <model>", "Claude model", DEFAULT_ASK_MODEL)
    .option(
      "--output-schema <schema>",
      "JSON schema file path or inline JSON object for the answer. On Windows, use a file path",
    )
    .option("--timeout <duration>", "Longest time for the call (e.g. 30s, 2m)", DEFAULT_ASK_TIMEOUT)
    .option("--account <name>", "Use this pooled account only (no retry on another)");
  addDaemonHostOption(cmd).action(
    withGlobalOptions(
      async (promptArgument: string | undefined, options: AskOptions, _command: Command) => {
        try {
          const prompt = (await readPrompt(promptArgument)).trim();
          if (!prompt) throw new AskCommandError("BAD_INPUT", "Give a prompt");
          let schema: Record<string, unknown> | undefined;
          if (options.outputSchema) {
            try {
              schema = loadOutputSchema(options.outputSchema);
            } catch (error) {
              const e = error as { message?: string };
              throw new AskCommandError(
                "INVALID_OUTPUT_SCHEMA",
                e?.message ?? "Invalid output schema",
              );
            }
          }
          let timeoutMs: number;
          try {
            timeoutMs = parseDuration(options.timeout);
          } catch (error) {
            throw new AskCommandError("BAD_INPUT", (error as Error).message);
          }
          const client = await connectToDaemon({ target: options.daemonTarget });
          try {
            const result = await runAsk(client, {
              prompt,
              model: options.model,
              ...(schema ? { schema } : {}),
              ...(options.account ? { account: options.account } : {}),
              timeoutMs,
            });
            process.stdout.write(
              `${JSON.stringify({
                output: result.output,
                account: result.account,
                model: result.model,
                costUsd: result.costUsd,
              })}\n`,
            );
          } finally {
            await client.close().catch(() => {});
          }
        } catch (error) {
          const e = error as { code?: string; message?: string };
          process.stderr.write(
            `${JSON.stringify({ error: { code: e.code ?? "ASK_FAILED", message: e.message ?? String(error) } })}\n`,
          );
          process.exitCode = 1;
        }
      },
    ),
  );
  return cmd;
}

import { Command } from "commander";
import {
  assertNotInsideOwnDaemonSession,
  stopDaemonInstance,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import { connectToDaemon } from "../../utils/client.js";
import { withOutput, type CommandOptions } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { describeDaemonTarget } from "../../utils/daemon-target.js";
import { parseTimeoutMs } from "./local-daemon.js";

export function daemonStopCommand(): Command {
  return addJsonAndDaemonHostOptions(new Command("stop").description("Stop the selected daemon"))
    .option("--timeout <seconds>", "Graceful exit deadline (default: 15)")
    .option("--force", "Permit forced local process cleanup")
    .option("--kill-timeout <seconds>", "Forced exit deadline (default: 3)")
    .option(
      "--override-session-guard",
      "Stop even when this shell may run inside a session of that daemon (operators outside sessions only)",
    )
    .action(withOutput(runStopCommand));
}

export async function runStopCommand(options: CommandOptions, _command: Command) {
  const target = options.daemonTarget;
  const timeoutMs = parseTimeoutMs(options.timeout, 15_000);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const override = options.overrideSessionGuard === true;
  const requestShutdown = async (instance?: DaemonInstance) => {
    const client = await connectToDaemon({ target, timeout: remaining(), instance });
    try {
      assertNotInsideOwnDaemonSession({
        action: "stop",
        serverId: client.getLastServerInfoMessage()?.serverId,
        override,
      });
      await client.shutdownServer({ timeout: remaining() });
    } finally {
      await client.close();
    }
  };
  if (target.kind === "endpoint" && options.force)
    throw {
      code: "INVALID_OPTIONS",
      message: "--force requires a local --home; an endpoint gives no remote process authority.",
    };
  const result: {
    action: string;
    home?: string;
    host?: string;
    pid?: number | null;
    forced?: boolean;
    usedLifecycleRpc?: boolean;
  } =
    target.kind === "instance"
      ? {
          ...(await stopDaemonInstance(target.home, {
            force: options.force === true,
            timeoutMs,
            killTimeoutMs: parseTimeoutMs(options.killTimeout, 3_000),
            requestShutdown,
            overrideSessionGuard: override,
          })),
          home: target.home,
        }
      : (await requestShutdown(),
        { action: "shutdown_requested", host: describeDaemonTarget(target) });
  return {
    type: "single" as const,
    data: result,
    schema: {
      idField: "action" as const,
      columns: [],
      renderHuman: () =>
        target.kind === "endpoint"
          ? "Shutdown requested; remote process exit was not verified."
          : `${result.action.replaceAll("_", " ")}: ${target.home}`,
    },
  };
}

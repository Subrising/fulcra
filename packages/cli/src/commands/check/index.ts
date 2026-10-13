import { Command, Argument } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption, withGlobalOptions } from "../../utils/command-options.js";
import { toCommandError } from "../../output/render.js";
import type { CommandOptions } from "../../output/index.js";
import {
  checkBranch,
  checkIdentity,
  checkSessionArchive,
  checkWorktree,
  formatChecks,
  type CheckResult,
} from "./checks.js";
interface CheckOptions extends CommandOptions {
  cwd: string;
  range?: string;
  base: string;
  id?: string;
  fullResult?: boolean;
  remote: string;
}
export function createCheckCommand(): Command {
  return addDaemonHostOption(
    new Command("check")
      .description("Read lifecycle evidence. This command never deletes, stops, or pushes.")
      .addArgument(new Argument("<kind>").choices(["identity", "branch", "worktree", "session"]))
      .option("--cwd <path>", "Git checkout to check", process.cwd())
      .option("--range <range>", "Commit range for identity")
      .option("--full-result", "Show every invalid commit identity")
      .option("--remote <name>", "Git remote for branch and worktree checks", "origin")
      .option("--base <ref>", "Merge target for worktree removal", "origin/main")
      .option("--id <id>", "Session ID for archive safety"),
  ).action(
    withGlobalOptions(async (kind: string, options: CheckOptions) => {
      let checks: CheckResult[];
      try {
        if (kind === "identity") {
          if (!options.range) throw new Error("Use --range for the identity check");
          checks = await checkIdentity(options.cwd, options.range, undefined, options.fullResult);
        } else if (kind === "branch")
          checks = await checkBranch(options.cwd, undefined, options.remote);
        else if (kind === "worktree")
          checks = await checkWorktree(options.cwd, options.base, undefined, options.remote);
        else if (kind === "session") {
          if (!options.id) throw new Error("Use --id for the session check");
          const client = await connectToDaemon({ target: options.daemonTarget });
          try {
            checks = checkSessionArchive(
              (await client.fetchAgent({ agentId: options.id }))?.agent ?? null,
            );
          } finally {
            await client.close();
          }
        } else throw new Error("Use identity, branch, worktree, or session");
      } catch (error) {
        checks = [{ check: kind, pass: false, reason: toCommandError(error).message }];
      }
      process.stdout.write(formatChecks(checks) + "\n");
      if (checks.some((check) => !check.pass)) process.exitCode = 1;
    }),
  );
}

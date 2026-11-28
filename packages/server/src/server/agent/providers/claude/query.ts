import { guardClaudeApiRuntime } from "./api-key-runtime.js";
import { assertSafeClaudeApiSettings, assertClaudeApiCommand } from "./api-key-settings.js";
import { trustedClaudeDenyRules } from "../../../plugins/trusted.js";
import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, type Options, type Query, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { buildSelfNodeCommand, createExternalProcessEnv } from "../../../paseo-env.js";
<<<<<<< HEAD
import { spawnProcess, type SpawnProcessOptions } from "../../../../utils/spawn.js";
import { moveMcpConfigOffArgv } from "./mcp-config-file.js";
=======
import { execCommand, spawnProcess } from "../../../../utils/spawn.js";
import type { AgentLaunchContext } from "../../agent-sdk-types.js";
>>>>>>> refs/remotes/upstream/tags/v0.17.6

// Keep the raw SDK query import in this module only. Claude process launch behavior
// must stay shared between production and tests so Windows .cmd/.bat handling cannot
// diverge from the daemon path.

export type ClaudeOptions = Options;
export type ClaudeQueryInput = Parameters<typeof query>[0] & { options: ClaudeOptions };
export type ClaudeQueryFactory = (input: ClaudeQueryInput) => Query;

export interface ClaudeQueryContext {
  runtimeSettings?: ProviderRuntimeSettings;
  launchEnv?: Record<string, string>;
  /** Start Claude Code as `[...wrap, command, ...args]`. */
  wrap?: AgentLaunchContext["wrap"];
  queryFactory?: ClaudeQueryFactory;
  /** Called with the spawned child process so the caller can tree-kill it on close. */
  onChildProcess?: (child: ChildProcess) => void;
}

// Apply this at the final spawn boundary too: the SDK and runtime overlays rebuild the environment.
export function sanitizeClaudeApiEnv(env: Record<string, string | undefined>): void {
  for (const name of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|FULCRA_API_KEY_)/i.test(
        name,
      ) ||
      /sk-ant-api/i.test(name) ||
      /sk-ant-api/i.test(env[name] ?? "")
    )
      delete env[name];
  }
}

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

function resolveClaudeSpawnCommand(
  spawnOptions: Pick<SpawnOptions, "command" | "args">,
  runtimeSettings?: ProviderRuntimeSettings,
): { command: string; args: string[] } {
  const commandConfig = runtimeSettings?.command;
  if (!commandConfig || commandConfig.mode === "default") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args],
    };
  }

  if (commandConfig.mode === "append") {
    return {
      command: spawnOptions.command,
      args: [...spawnOptions.args, ...(commandConfig.args ?? [])],
    };
  }

  return {
    command: commandConfig.argv[0],
    args: [...commandConfig.argv.slice(1), ...spawnOptions.args],
  };
}

<<<<<<< HEAD
function prepareApiKeyGuard(
  launchEnv: Record<string, string> | undefined,
  cwd: string | undefined,
  env: Record<string, string>,
  args: string[],
) {
  if (!launchEnv?.FULCRA_API_KEY_HELPER) return null;
  assertClaudeApiCommand(args, launchEnv.FULCRA_API_KEY_HELPER);
  assertSafeClaudeApiSettings(cwd ?? process.cwd(), env);
  if (args.some((arg) => /sk-ant-api/i.test(arg)))
    throw new Error("Remove API keys from the Claude command arguments");
  return guardClaudeApiRuntime(launchEnv.FULCRA_API_KEY_ACCOUNT);
}

function buildClaudeSpawnEnv(
  baseEnv: SpawnOptions["env"],
  runtimeSettings: ProviderRuntimeSettings | undefined,
  launchEnv: Record<string, string> | undefined,
) {
  const providerEnvSpec = createProviderEnvSpec({
    baseEnv,
    runtimeSettings,
    overlays: [launchEnv],
  });
  // Session-open hooks may explicitly supply a client identity. Keep inherited
  // SDK/parent identities cleared while honoring this launch-only contribution.
  providerEnvSpec.envOverlay.CLAUDE_CODE_ENTRYPOINT = launchEnv?.CLAUDE_CODE_ENTRYPOINT;
  const providerEnv = createExternalProcessEnv(baseEnv, providerEnvSpec.envOverlay);
  // A pooled API launch owns authentication; inherited keys and tokens never reach it.
  if (launchEnv?.FULCRA_API_KEY_HELPER) sanitizeClaudeApiEnv(providerEnv);
  return { providerEnvSpec, providerEnv };
=======
type ClaudeLaunchEnvironment = Pick<ClaudeQueryContext, "runtimeSettings" | "launchEnv">;

function createClaudeSpawnEnvSpec(
  baseEnv: SpawnOptions["env"],
  { runtimeSettings, launchEnv }: ClaudeLaunchEnvironment,
) {
  const spec = createProviderEnvSpec({ baseEnv, runtimeSettings, overlays: [launchEnv] });
  // Session-open hooks may supply a client identity. Clear inherited SDK/parent identities.
  spec.envOverlay.CLAUDE_CODE_ENTRYPOINT = launchEnv?.CLAUDE_CODE_ENTRYPOINT;
  return spec;
}

export interface ClaudeLaunchVersionProbe extends ClaudeLaunchEnvironment {
  executable: string;
  cwd: string;
  env: SpawnOptions["env"];
}

export function probeClaudeLaunchVersion(
  launch: ClaudeLaunchVersionProbe,
): Promise<{ stdout: string; stderr: string }> {
  const { command, args } = resolveClaudeSpawnCommand(
    { command: launch.executable, args: ["--version"] },
    launch.runtimeSettings,
  );
  return execCommand(command, args, {
    ...createClaudeSpawnEnvSpec(launch.env, launch),
    cwd: launch.cwd,
    shell: false,
    timeout: 5_000,
  });
>>>>>>> refs/remotes/upstream/tags/v0.17.6
}

function applyRuntimeSettingsToClaudeOptions(
  options: ClaudeOptions,
  context: ClaudeQueryContext,
): ClaudeOptions {
  const { runtimeSettings, onChildProcess, wrap } = context;
  return {
    ...options,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const resolved = resolveClaudeSpawnCommand(spawnOptions, runtimeSettings);
      // When the SDK passes a default JS runtime ("node"/"bun"), replace it with
      // process.execPath — the actual node binary running the daemon. This avoids
      // PATH lookup failures in the managed runtime bundle.
      // When the SDK passes a native binary path (from pathToClaudeCodeExecutable)
      // or the user overrides the command via runtime settings, use that directly.
<<<<<<< HEAD
      const isDefaultRuntime = ["node", "bun"].includes(resolved.command);
      const api = Boolean(launchEnv?.FULCRA_API_KEY_HELPER);
      const { providerEnvSpec, providerEnv } = buildClaudeSpawnEnv(
        spawnOptions.env,
        runtimeSettings,
        launchEnv,
      );
=======
      const isDefaultRuntime = resolved.command === "node" || resolved.command === "bun";
      const providerEnvSpec = createClaudeSpawnEnvSpec(spawnOptions.env, context);
      const providerEnv = createExternalProcessEnv(spawnOptions.env, providerEnvSpec.envOverlay);
>>>>>>> refs/remotes/upstream/tags/v0.17.6
      const selfNodeCommand = isDefaultRuntime
        ? buildSelfNodeCommand(resolved.args, providerEnv)
        : null;
      if (api && selfNodeCommand) sanitizeClaudeApiEnv(selfNodeCommand.env);
      const command = selfNodeCommand?.command ?? resolved.command;
<<<<<<< HEAD
      // The MCP config can hold the agent's bearer token. Keep it out of argv, where the process list shows it.
      const moved = moveMcpConfigOffArgv(selfNodeCommand?.args ?? resolved.args);
      const args = moved.args;
      let guard: ReturnType<typeof prepareApiKeyGuard>;
      try {
        guard = prepareApiKeyGuard(launchEnv, spawnOptions.cwd, providerEnv, args);
      } catch (error) {
        moved.cleanup();
        throw error;
      }
      let spawnEnv: SpawnProcessOptions = providerEnvSpec;
      if (api) spawnEnv = { baseEnv: providerEnv, envOverlay: {} };
      if (selfNodeCommand) spawnEnv = { env: selfNodeCommand.env, envMode: "internal" };
      let child: ChildProcess;
      try {
        child = spawnProcess(command, args, {
          cwd: spawnOptions.cwd,
          ...spawnEnv,
          signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "pipe"],
          // Bypass cmd.exe on Windows: the SDK passes --mcp-config with inline JSON
          // containing double quotes, which cmd.exe mangles (strips quotes, breaks parsing).
          // The command is always a resolved binary path, so shell routing is unnecessary.
          shell: false,
        });
      } catch (error) {
        guard?.close();
        moved.cleanup();
        throw error;
      }
      child.once("exit", moved.cleanup);
      child.once("error", moved.cleanup);
      guard?.attach(child);
=======
      const args = selfNodeCommand?.args ?? resolved.args;
      const child = spawnProcess(command, args, {
        wrap,
        cwd: spawnOptions.cwd,
        ...(selfNodeCommand
          ? { env: selfNodeCommand.env, envMode: "internal" as const }
          : providerEnvSpec),
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "pipe"],
        // Bypass cmd.exe on Windows: the SDK passes --mcp-config with inline JSON
        // containing double quotes, which cmd.exe mangles (strips quotes, breaks parsing).
        // The command is always a resolved binary path, so shell routing is unnecessary.
        shell: false,
      });
>>>>>>> refs/remotes/upstream/tags/v0.17.6
      onChildProcess?.(child);
      if (typeof options.stderr === "function") {
        child.stderr?.on("data", (chunk: Buffer | string) => {
          options.stderr?.(chunk.toString());
        });
      }
      if (!isChildProcessWithStreams(child)) {
        throw new Error("Claude process was spawned without stdio streams");
      }
      return child;
    },
  };
}

export function applyTrustedClaudeDeny(options: ClaudeOptions): ClaudeOptions {
  const rules = trustedClaudeDenyRules();
  if (rules.length === 0) return options;
  // A settings path cannot be merged without dropping its settings; refuse it rather than weakening policy.
  if (typeof options.settings === "string")
    throw new Error("Trusted Claude deny requires inline settings");
  const settings = options.settings ?? {};
  return {
    ...options,
    disallowedTools: [...new Set([...(options.disallowedTools ?? []), ...rules])],
    settings: {
      ...settings,
      permissions: {
        ...settings.permissions,
        deny: [...new Set([...(settings.permissions?.deny ?? []), ...rules])],
      },
    },
  };
}

export function claudeQuery(input: ClaudeQueryInput, context: ClaudeQueryContext = {}): Query {
  const launchQuery = context.queryFactory ?? query;
  return launchQuery({
    ...input,
    options: applyTrustedClaudeDeny(applyRuntimeSettingsToClaudeOptions(input.options, context)),
  });
}

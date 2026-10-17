import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assertInstructionPath,
  offerInstructionUpdate,
  replaceInstructionFile,
  retireInstructionFile,
} from "../../server/instruction-files.js";
import { homedir } from "node:os";
import path from "node:path";

// Hook-only files from releases before whole-file ownership receipts.
const SHIPPED_HOOK_HASHES: Record<string, readonly string[]> = {
  claude: ["be2546f2a6b073fe958644a8cfe775db50855834388486aae9282afa36337d27"],
  codex: ["7eca8de2b9ef6906c3d84aac162b1f100f8ec1670275d8de29cef3ec9765ccc6"],
  opencode: ["ab95ec67c18fe25f5f28deff383ecf986ff850087080d5c049b11c3a65217282"],
};

export interface AgentHookEventDefinition {
  event: string;
}

export type AgentHookActivityState = "running" | "idle" | "needs-input";

export interface AgentHookActivityInput {
  isTTY?: boolean;
  read(): Promise<string | null>;
}

export interface AgentHookProvider<TConfig = unknown> {
  id: string;
  events: AgentHookEventDefinition[];
  resolveActivity(input: {
    event: string;
    input: AgentHookActivityInput;
  }): Promise<AgentHookActivityState | null>;
  install: AgentHookInstallStrategy<TConfig>;
}

export type AgentHookInstallStrategy<TConfig> =
  | AgentHookConfigFileInstallStrategy<TConfig>
  | AgentHookPluginFileInstallStrategy;

interface AgentHookInstallStrategyBase {
  kind: "config-file" | "plugin-file";
  configDir: string;
  configDirBase?: "home" | "xdg-config";
  configFile: string;
  configDirEnvOverride?: string;
  hookMarker: string;
}

export interface AgentHookConfigFileInstallStrategy<TConfig> extends AgentHookInstallStrategyBase {
  kind: "config-file";
  format: AgentHookConfigFormat<TConfig>;
}

export interface AgentHookPluginFileInstallStrategy extends AgentHookInstallStrategyBase {
  kind: "plugin-file";
  source: string;
}

export interface AgentHookConfigFormat<TConfig> {
  empty(): TConfig;
  parse(raw: string): TConfig;
  stringify(config: TConfig): string;
  install(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  uninstall(config: TConfig, provider: AgentHookProvider<TConfig>): TConfig;
  isInstalled(config: TConfig, provider: AgentHookProvider<TConfig>): boolean;
}

export interface AgentHookInstallOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configDir?: string;
}

export interface AgentHookInstallLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface AgentHookInstallResult {
  configPath: string;
  changed: boolean;
}

export function installAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return installAgentHookPluginFile(provider.install, options, provider.id);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(provider, options, (config) => format.install(config, provider));
}

export function uninstallAgentHooks<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): AgentHookInstallResult {
  if (provider.install.kind === "plugin-file") {
    return uninstallAgentHookPluginFile(provider.install, options);
  }

  const format = provider.install.format;
  return updateAgentHookConfig(
    provider,
    options,
    (config) => format.uninstall(config, provider),
    false,
  );
}

export function agentHooksAreInstalled<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): boolean {
  const configPath = resolveAgentHookConfigPath(provider, options);
  if (!existsSync(configPath)) {
    return false;
  }
  if (provider.install.kind === "plugin-file") {
    const currentRaw = readFileSync(configPath, "utf8");
    return normalizeRawConfig(currentRaw) === normalizeRawConfig(provider.install.source);
  }

  const config = provider.install.format.parse(readFileSync(configPath, "utf8"));
  return provider.install.format.isInstalled(config, provider);
}

export function resolveAgentHookConfigPath<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions = {},
): string {
  return resolveAgentHookInstallPath(provider.install, options);
}

function resolveAgentHookInstallPath<TConfig>(
  install: AgentHookInstallStrategy<TConfig>,
  options: AgentHookInstallOptions,
): string {
  const configDir =
    options.configDir ??
    resolveConfiguredDirectory({
      install,
      env: options.env ?? process.env,
      homeDir: options.homeDir ?? homedir(),
    });
  return path.join(configDir, install.configFile);
}

export function buildAgentHookShellCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookCommand = `"\${PASEO_HOOK_CLI:-paseo}" hooks ${shellToken(provider.id)} ${shellToken(event.event)}`;
  return `if [ -n "$PASEO_TERMINAL_ID" ]; then ${hookCommand}; fi`;
}

export function buildAgentHookWindowsCommand<TConfig>(
  provider: AgentHookProvider<TConfig>,
  event: AgentHookEventDefinition,
): string {
  const hookArgs = `hooks ${windowsToken(provider.id)} ${windowsToken(event.event)}`;
  return `if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" ${hookArgs}) else (paseo ${hookArgs})) else (exit /b 0)`;
}

function installAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
  providerId: string,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  assertInstructionPath(configPath);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const nextRaw = normalizeRawConfig(install.source);

  return writeManagedHookConfig(
    configPath,
    currentRaw,
    nextRaw,
    nextRaw,
    SHIPPED_HOOK_HASHES[providerId],
  );
}

function uninstallAgentHookPluginFile(
  install: AgentHookPluginFileInstallStrategy,
  options: AgentHookInstallOptions,
): AgentHookInstallResult {
  const configPath = resolveAgentHookInstallPath(install, options);
  if (!existsSync(configPath)) {
    return { configPath, changed: false };
  }

  assertInstructionPath(configPath);
  const raw = readFileSync(configPath, "utf8");
  const recordPath = hookInstallRecord(configPath);
  assertInstructionPath(recordPath);
  const previousHash = existsSync(recordPath) ? readFileSync(recordPath, "utf8").trim() : undefined;
  if (
    previousHash !== undefined
      ? fileHash(raw) !== previousHash
      : normalizeRawConfig(raw) !== normalizeRawConfig(install.source)
  ) {
    warnPreservedSettings(configPath);
    return { configPath, changed: false };
  }
  const recordRaw = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : null;
  if (!retireInstructionFile(configPath, fileHash(raw))) {
    warnPreservedSettings(configPath);
    return { configPath, changed: false };
  }
  if (recordRaw !== null) retireInstructionFile(recordPath, fileHash(recordRaw));
  return { configPath, changed: true };
}

function updateAgentHookConfig<TConfig>(
  provider: AgentHookProvider<TConfig>,
  options: AgentHookInstallOptions,
  update: (config: TConfig) => TConfig,
  installing = true,
): AgentHookInstallResult {
  const install = provider.install;
  if (install.kind !== "config-file") {
    throw new Error(`Provider ${provider.id} does not use config-file hooks`);
  }
  const configPath = resolveAgentHookConfigPath(provider, options);
  assertInstructionPath(configPath);
  const currentRaw = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  if (!installing && currentRaw === null) return { configPath, changed: false };
  const bundledRaw = install.format.stringify(update(install.format.empty()));
  let currentConfig: TConfig;
  try {
    currentConfig = currentRaw === null ? install.format.empty() : install.format.parse(currentRaw);
  } catch {
    if (installing) offerInstructionUpdate(configPath, Buffer.from(bundledRaw), true);
    return { configPath, changed: false };
  }
  const nextConfig = update(currentConfig);
  const nextRaw = install.format.stringify(nextConfig);

  return writeManagedHookConfig(
    configPath,
    currentRaw,
    nextRaw,
    installing ? bundledRaw : null,
    SHIPPED_HOOK_HASHES[provider.id],
  );
}

function hookInstallRecord(configPath: string): string {
  return path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.paseo-installed.sha256`,
  );
}

function fileHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const preservedSettings = new Set<string>();

function warnPreservedSettings(configPath: string): void {
  if (preservedSettings.has(configPath)) return;
  preservedSettings.add(configPath);
  console.warn("Preserved locally edited agent settings: %s", configPath);
}

function writeManagedHookConfig(
  configPath: string,
  currentRaw: string | null,
  nextRaw: string,
  bundledRaw: string | null = nextRaw,
  shippedHashes: readonly string[] = [],
): AgentHookInstallResult {
  const recordPath = hookInstallRecord(configPath);
  assertInstructionPath(configPath);
  assertInstructionPath(recordPath);
  const previousRecord = existsSync(recordPath) ? readFileSync(recordPath) : null;
  const previousHash = previousRecord?.toString("utf8").trim();
  const currentHash = currentRaw === null ? undefined : fileHash(currentRaw);
  const owned =
    currentRaw === null ||
    (previousHash !== undefined
      ? currentHash === previousHash
      : shippedHashes.includes(currentHash!));
  const matches = currentRaw !== null && normalizeRawConfig(currentRaw) === nextRaw;
  if (matches) {
    if (owned && previousHash === undefined && currentHash !== undefined)
      replaceInstructionFile(recordPath, Buffer.from(`${currentHash}\n`), undefined);
    return { configPath, changed: false };
  }
  if (!owned) {
    if (bundledRaw !== null)
      offerInstructionUpdate(configPath, Buffer.from(bundledRaw), bundledRaw !== nextRaw);
    return { configPath, changed: false };
  }
  if (
    !replaceInstructionFile(
      configPath,
      Buffer.from(nextRaw),
      currentRaw === null ? undefined : fileHash(currentRaw),
      currentRaw === null ? 0o600 : lstatSync(configPath).mode & 0o777,
    )
  ) {
    if (bundledRaw !== null)
      offerInstructionUpdate(configPath, Buffer.from(bundledRaw), bundledRaw !== nextRaw);
    return { configPath, changed: false };
  }
  replaceInstructionFile(
    recordPath,
    Buffer.from(`${fileHash(nextRaw)}\n`),
    previousRecord === null ? undefined : fileHash(previousRecord.toString()),
  );
  return { configPath, changed: true };
}

function resolveConfiguredDirectory<TConfig>(input: {
  install: AgentHookInstallStrategy<TConfig>;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const overrideName = input.install.configDirEnvOverride;
  const override = overrideName ? input.env[overrideName] : undefined;
  if (override) {
    return override;
  }

  if (input.install.configDirBase === "xdg-config") {
    return path.join(resolveXdgConfigHome(input), input.install.configDir);
  }

  return path.join(input.homeDir, input.install.configDir);
}

function resolveXdgConfigHome(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  if (input.env.XDG_CONFIG_HOME) {
    return input.env.XDG_CONFIG_HOME;
  }

  return path.join(input.homeDir, ".config");
}

function normalizeRawConfig(raw: string): string {
  return raw.endsWith("\n") ? raw : `${raw}\n`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

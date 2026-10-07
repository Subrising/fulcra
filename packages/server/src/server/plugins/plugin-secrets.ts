import { execFile } from "node:child_process";
import type { PluginSecrets } from "@getpaseo/plugin/server";
import {
  createPlatformCredentialBackend,
  type CredentialBackend,
} from "../integrations/credential-backend.js";

// Plugin secrets live in the macOS login keychain as generic passwords. The service name is derived
// from the plugin id the host started the process with, so a plugin can only name an account inside its
// own namespace. The value is returned to the plugin and nowhere else: it never enters argv, logs, RPC
// output or error text, and the host withholds any plugin output that contains one.
export const SECURITY_BINARY = "/usr/bin/security";
const SECRET_NOT_FOUND_EXIT = 44;
const SECRET_NAME = /^[a-z0-9][a-z0-9.:-]{0,127}$/;
const PLUGIN_ID = /^[a-z][a-z0-9._-]*$/;
const MAX_SECRET_LENGTH = 8192;
const MAX_TRACKED_VALUES = 32;
// Short values would redact ordinary words, and no real credential is this short.
const MIN_REDACTED_LENGTH = 8;

export interface SecretCommandResult {
  exitCode: number;
  stdout: string;
}

export type SecretCommandRunner = (file: string, args: string[]) => Promise<SecretCommandResult>;

export class PluginSecretUnavailableError extends Error {
  constructor() {
    super("Plugin secret is unavailable on this host");
    this.name = "PluginSecretUnavailableError";
  }
}

export interface PluginSecretStore {
  secrets: PluginSecrets;
  redact(text: string): string;
  containsSecret(value: unknown): boolean;
}

export interface CreatePluginSecretStoreOptions {
  pluginId: string;
  platform?: NodeJS.Platform;
  run?: SecretCommandRunner;
  // Where `save` writes. Defaults to the host's platform credential store; null leaves `save` unavailable.
  backend?: CredentialBackend | null;
}

// FULCRA(plugin-sdk): items a plugin saves itself. A separate service from the legacy read-only namespace, so the
// credential backend's write fence for `ai.fulcra.plugin.*` is untouched.
export function pluginStoreService(pluginId: string): string {
  if (!PLUGIN_ID.test(pluginId) || pluginId.includes("_"))
    throw new Error("Invalid plugin id for secrets");
  return `ai.fulcra.plugin-store.${pluginId}`;
}

export function pluginSecretService(pluginId: string): string {
  if (!PLUGIN_ID.test(pluginId)) throw new Error("Invalid plugin id for secrets");
  return `ai.fulcra.plugin.${pluginId}`;
}

// stderr is discarded: security prints item attributes there, and nothing from it is needed.
export function runSecurityCommand(file: string, args: string[]): Promise<SecretCommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: {}, timeout: 10_000, maxBuffer: 65_536, encoding: "utf8" },
      (error, stdout) => {
        if (!error) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        resolve({ exitCode: typeof error.code === "number" ? error.code : 1, stdout: "" });
      },
    );
  });
}

function assertSecretName(name: string): void {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    throw new Error("Invalid plugin secret name");
  }
}

// A secret must be one line of printable text.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseSecretValue(stdout: string): string {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!value || value.length > MAX_SECRET_LENGTH || hasControlCharacter(value)) {
    throw new PluginSecretUnavailableError();
  }
  return value;
}

export function createPluginSecretStore(
  options: CreatePluginSecretStoreOptions,
): PluginSecretStore {
  const service = pluginSecretService(options.pluginId);
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runSecurityCommand;
  const liveValues: string[] = [];

  function remember(value: string): void {
    if (value.length < MIN_REDACTED_LENGTH || liveValues.includes(value)) return;
    liveValues.push(value);
    if (liveValues.length > MAX_TRACKED_VALUES) liveValues.shift();
  }

  async function lookup(name: string, withValue: boolean): Promise<SecretCommandResult> {
    assertSecretName(name);
    if (platform !== "darwin") throw new PluginSecretUnavailableError();
    const args = ["find-generic-password", "-s", service, "-a", name, ...(withValue ? ["-w"] : [])];
    return run(SECURITY_BINARY, args);
  }

  const backend =
    options.backend === undefined ? createPlatformCredentialBackend(platform) : options.backend;
  const storeService = (() => {
    try {
      return pluginStoreService(options.pluginId);
    } catch {
      return null;
    }
  })();
  async function readSaved(name: string): Promise<string | null> {
    assertSecretName(name);
    if (!backend || !storeService) return null;
    try {
      return await backend.get(storeService, name);
    } catch {
      throw new PluginSecretUnavailableError();
    }
  }

  const secrets: PluginSecrets = {
    async read(name) {
      const saved = await readSaved(name);
      if (saved !== null) {
        const value = parseSecretValue(saved);
        remember(value);
        return value;
      }
      const result = await lookup(name, true);
      if (result.exitCode === SECRET_NOT_FOUND_EXIT) return null;
      if (result.exitCode !== 0) throw new PluginSecretUnavailableError();
      const value = parseSecretValue(result.stdout);
      remember(value);
      return value;
    },
    async exists(name) {
      if ((await readSaved(name)) !== null) return true;
      const result = await lookup(name, false);
      if (result.exitCode === SECRET_NOT_FOUND_EXIT) return false;
      if (result.exitCode !== 0) throw new PluginSecretUnavailableError();
      return true;
    },
    async save(name, value) {
      assertSecretName(name);
      if (!backend || !storeService) throw new PluginSecretUnavailableError();
      if (
        typeof value !== "string" ||
        !value ||
        value.length > MAX_SECRET_LENGTH ||
        hasControlCharacter(value)
      )
        throw new Error("A plugin secret must be one line of at most 8192 characters");
      try {
        await backend.set(storeService, name, value);
      } catch {
        throw new PluginSecretUnavailableError();
      }
      remember(value);
    },
    async remove(name) {
      assertSecretName(name);
      if (!backend || !storeService) throw new PluginSecretUnavailableError();
      try {
        await backend.delete(storeService, name);
      } catch {
        throw new PluginSecretUnavailableError();
      }
    },
  };

  return {
    secrets,
    redact(text) {
      return liveValues.reduce((current, value) => current.split(value).join("[redacted]"), text);
    },
    containsSecret(value) {
      if (!liveValues.length) return false;
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      return typeof encoded === "string" && liveValues.some((secret) => encoded.includes(secret));
    },
  };
}

export class PluginOutputWithheldError extends Error {
  constructor() {
    super("Plugin output withheld: it contained a plugin secret");
    this.name = "PluginOutputWithheldError";
  }
}

export function guardPluginOutput<Value>(store: PluginSecretStore | null, output: Value): Value {
  if (store?.containsSecret(output)) throw new PluginOutputWithheldError();
  return output;
}

export function redactPluginError(store: PluginSecretStore | null, message: string): string {
  return store ? store.redact(message) : message;
}

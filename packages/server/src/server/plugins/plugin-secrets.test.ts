import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PluginOutputWithheldError,
  PluginSecretUnavailableError,
  SECURITY_BINARY,
  createPluginSecretStore,
  guardPluginOutput,
  pluginSecretService,
  redactPluginError,
  type SecretCommandResult,
} from "./plugin-secrets.js";

const CANARY = "CANARY-plugin-secret-0123456789";

interface RecordedCall {
  file: string;
  args: string[];
}

function fakeSecurity(items: Record<string, string>) {
  const calls: RecordedCall[] = [];
  async function run(file: string, args: string[]): Promise<SecretCommandResult> {
    calls.push({ file, args });
    const key = `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
    if (!(key in items)) return { exitCode: 44, stdout: "" };
    return { exitCode: 0, stdout: args.includes("-w") ? `${items[key]}\n` : "" };
  }
  return { calls, run };
}

describe("plugin secrets", () => {
  it("P1: reads only inside the namespace of the plugin id the host started", async () => {
    const security = fakeSecurity({
      "ai.fulcra.plugin.orca-organization/github.com:read": CANARY,
      "ai.fulcra.plugin.other-plugin/github.com:read": "other-plugin-secret-value",
    });
    const store = createPluginSecretStore({
      pluginId: "orca-organization",
      platform: "darwin",
      run: security.run,
    });
    await expect(store.secrets.read("github.com:read")).resolves.toBe(CANARY);
    expect(security.calls).toEqual([
      {
        file: SECURITY_BINARY,
        args: [
          "find-generic-password",
          "-s",
          "ai.fulcra.plugin.orca-organization",
          "-a",
          "github.com:read",
          "-w",
        ],
      },
    ]);
    await expect(store.secrets.read("missing:read")).resolves.toBeNull();
    expect(() => pluginSecretService("../escape")).toThrow("Invalid plugin id");
  });

  it("P2: rejects names that could leave the account space and never reads the value for exists", async () => {
    const security = fakeSecurity({ "ai.fulcra.plugin.p/github.com:read": CANARY });
    const store = createPluginSecretStore({ pluginId: "p", platform: "darwin", run: security.run });
    for (const name of ["", "Upper", "a b", "-s", "x".repeat(129), "../x"]) {
      await expect(store.secrets.read(name)).rejects.toThrow("Invalid plugin secret name");
    }
    await expect(store.secrets.exists("github.com:read")).resolves.toBe(true);
    await expect(store.secrets.exists("nope")).resolves.toBe(false);
    expect(security.calls.every((call) => !call.args.includes("-w"))).toBe(true);
    expect(store.containsSecret({ value: CANARY })).toBe(false);
  });

  it("P3: withholds any plugin output that contains a secret this plugin read", async () => {
    const security = fakeSecurity({ "ai.fulcra.plugin.p/github.com:read": CANARY });
    const store = createPluginSecretStore({ pluginId: "p", platform: "darwin", run: security.run });
    expect(guardPluginOutput(store, { ok: true })).toEqual({ ok: true });
    await store.secrets.read("github.com:read");
    expect(() => guardPluginOutput(store, { nested: [`Bearer ${CANARY}`] })).toThrow(
      PluginOutputWithheldError,
    );
    expect(() => guardPluginOutput(store, CANARY)).toThrow(PluginOutputWithheldError);
    expect(guardPluginOutput(store, { ok: true })).toEqual({ ok: true });
  });

  it("P4: redacts a secret this plugin read from any error text sent to the host", async () => {
    const security = fakeSecurity({ "ai.fulcra.plugin.p/github.com:read": CANARY });
    const store = createPluginSecretStore({ pluginId: "p", platform: "darwin", run: security.run });
    await store.secrets.read("github.com:read");
    const message = redactPluginError(store, `request failed: Authorization: Bearer ${CANARY}`);
    expect(message).toBe("request failed: Authorization: Bearer [redacted]");
    expect(message).not.toContain(CANARY);
  });

  it("P5: fails closed with fixed text off macOS, on keychain errors and on malformed values", async () => {
    const off = createPluginSecretStore({
      pluginId: "p",
      platform: "linux",
      run: async () => ({ exitCode: 0, stdout: CANARY }),
    });
    await expect(off.secrets.read("github.com:read")).rejects.toThrow(PluginSecretUnavailableError);
    const broken = createPluginSecretStore({
      pluginId: "p",
      platform: "darwin",
      run: async () => ({ exitCode: 36, stdout: CANARY }),
    });
    const failure = await broken.secrets.read("github.com:read").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(PluginSecretUnavailableError);
    expect(String((failure as Error).message)).not.toContain(CANARY);
    const malformed = createPluginSecretStore({
      pluginId: "p",
      platform: "darwin",
      run: async () => ({ exitCode: 0, stdout: `two\nlines ${CANARY}\n` }),
    });
    await expect(malformed.secrets.read("github.com:read")).rejects.toThrow(
      PluginSecretUnavailableError,
    );
  });

  // plugin-process.ts registers process handlers at import, so its wiring is checked at the source.
  it("P6: the plugin process binds the namespace to the host plugin id and guards every result path", () => {
    const source = readFileSync(new URL("./plugin-process.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "secretStore = createPluginSecretStore({ pluginId: message.pluginId });",
    );
    expect(source).toContain("secrets: secretStore?.secrets,");
    expect(source).toContain(
      "return redactPluginError(secretStore, error instanceof Error ? error.message : String(error));",
    );
    expect(source).toContain(".then((output) => guardPluginOutput(secretStore, output))");
    expect(source).toContain("output: guardPluginOutput(secretStore, output),");
    expect(source.indexOf("secretStore = createPluginSecretStore")).toBeLessThan(
      source.indexOf("evaluateBundle(message.bundle);"),
    );
  });
});

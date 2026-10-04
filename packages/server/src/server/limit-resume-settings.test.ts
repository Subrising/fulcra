import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "./daemon-config-store.js";
import {
  loadPersistedConfig,
  readPersistedConfig,
  savePersistedConfig,
  editPersistedConfig,
} from "./persisted-config.js";
import { loadConfig } from "./config.js";
import { readNotificationSetting } from "./notification-settings.js";
import {
  limitResumeSettingsPath,
  readLimitResumeSetting,
  writeLimitResumeSetting,
} from "./limit-resume-settings.js";

const homes: string[] = [];
function home() {
  const value = mkdtempSync(path.join(tmpdir(), "resume-setting-compat-"));
  homes.push(value);
  return value;
}
function initial() {
  return MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } });
}
afterEach(() => {
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

test.each([false, true])(
  "mutable preference %s is sidecar-only and survives return to new reader",
  (enabled) => {
    const root = home();
    const config = {
      version: 1 as const,
      daemon: { listen: "127.0.0.1:6767", appendSystemPrompt: "preserved" },
      app: { baseUrl: "https://fixture.invalid" },
    };
    savePersistedConfig(root, config);
    const before = readFileSync(path.join(root, "config.json"), "utf8");
    const store = new DaemonConfigStore(root, initial());
    expect(store.patch({ autoResumeOnLimit: enabled }).autoResumeOnLimit).toBe(enabled);
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
    expect(readLimitResumeSetting(root)).toBe(enabled);
    expect(readPersistedConfig(root).daemon?.autoResumeOnLimit).toBe(enabled);
    expect(new DaemonConfigStore(root, initial()).get().autoResumeOnLimit).toBe(enabled);
    expect(loadConfig(root, { env: {} }).autoResumeOnLimit).toBe(enabled);
    if (process.platform !== "win32")
      expect(statSync(limitResumeSettingsPath(root)).mode & 0o777).toBe(0o600);
  },
);

test("absent defaults enabled without materializing an unsupported main key", () => {
  const root = home();
  expect(readLimitResumeSetting(root)).toBeUndefined();
  expect(new DaemonConfigStore(root, initial()).get().autoResumeOnLimit).toBe(true);
  expect(
    JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).daemon.autoResumeOnLimit,
  ).toBeUndefined();
});

test.each([false, true])(
  "legacy main preference %s migrates without discarding other fields",
  (enabled) => {
    const root = home();
    const data = {
      version: 1,
      daemon: {
        listen: "127.0.0.1:6767",
        autoResumeOnLimit: enabled,
        appendSystemPrompt: "preserve",
      },
      agents: { providers: { codex: { enabled: false } } },
      app: { baseUrl: null },
    };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(data));
    expect(loadPersistedConfig(root).daemon?.autoResumeOnLimit).toBe(enabled);
    expect(readLimitResumeSetting(root)).toBe(enabled);
    const expected = {
      ...data,
      daemon: { listen: data.daemon.listen, appendSystemPrompt: data.daemon.appendSystemPrompt },
    };
    expect(JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"))).toEqual(expected);
  },
);

test("newer sidecar wins over migrated/stale main value and unrelated saves", () => {
  const root = home();
  writeLimitResumeSetting(root, false);
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ daemon: { autoResumeOnLimit: true, listen: "127.0.0.1:6767" } }),
  );
  const config = loadPersistedConfig(root);
  expect(config.daemon?.autoResumeOnLimit).toBe(false);
  writeLimitResumeSetting(root, true);
  savePersistedConfig(root, { ...config, app: { baseUrl: "https://newer.invalid" } });
  expect(readLimitResumeSetting(root)).toBe(true);
  expect(
    JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).daemon.autoResumeOnLimit,
  ).toBeUndefined();
});

test("stale store and unrelated config updates preserve preferences and identities", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ autoResumeOnLimit: false });
  const baseline = loadPersistedConfig(root);
  savePersistedConfig(root, {
    ...baseline,
    daemon: { ...baseline.daemon, listen: "127.0.0.1:9999" },
    integrations: { oauthClientIds: { drive: "fixture-public-client" } },
  });
  const before = readFileSync(path.join(root, "config.json"), "utf8");
  store.patch({ autoResumeOnLimit: true });
  expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
  store.patch({ appendSystemPrompt: "unrelated update" });
  expect(readLimitResumeSetting(root)).toBe(true);
  expect(loadPersistedConfig(root).integrations).toEqual({
    oauthClientIds: { drive: "fixture-public-client" },
  });
  expect(loadPersistedConfig(root).daemon?.listen).toBe("127.0.0.1:9999");
});

test("failed live application restores the prior preference without rewriting main", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ autoResumeOnLimit: false });
  const before = readFileSync(path.join(root, "config.json"), "utf8");
  store.onApply(() => {
    throw new Error("application refused");
  });
  expect(() => store.patch({ autoResumeOnLimit: true })).toThrow("application refused");
  expect(store.get().autoResumeOnLimit).toBe(false);
  expect(new DaemonConfigStore(root, initial()).get().autoResumeOnLimit).toBe(false);
  expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
});

test.each([
  "broken JSON",
  '{"v":1,"enabled":"false"}',
  '{"v":2,"enabled":false}',
  '{"v":1,"enabled":false,"future":true}',
  "x".repeat(1025),
])("invalid/future sidecar refuses without overwriting it", (text) => {
  const root = home();
  const file = limitResumeSettingsPath(root);
  mkdirSync(path.dirname(file));
  writeFileSync(file, text);
  expect(() => new DaemonConfigStore(root, initial())).toThrow(/resume preference/);
  expect(readFileSync(file, "utf8")).toBe(text);
});

test("explicit config edits route the setting to sidecar and preserve it across unrelated edits", () => {
  const root = home();
  editPersistedConfig(root, "daemon.autoResumeOnLimit", { value: false });
  expect(readLimitResumeSetting(root)).toBe(false);
  editPersistedConfig(root, "daemon.appendSystemPrompt", { value: "unrelated" });
  expect(readLimitResumeSetting(root)).toBe(false);
  expect(
    JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).daemon.autoResumeOnLimit,
  ).toBeUndefined();
  editPersistedConfig(root, "daemon.autoResumeOnLimit", { unset: true });
  expect(readLimitResumeSetting(root)).toBe(true);
});

test("malformed legacy/future main config is not cleaned up or allowed to enable resume", () => {
  const root = home();
  for (const daemon of [
    { autoResumeOnLimit: "false" },
    { autoResumeOnLimit: false, futureField: true },
  ]) {
    const text = JSON.stringify({ daemon });
    writeFileSync(path.join(root, "config.json"), text);
    expect(() => loadPersistedConfig(root)).toThrow("Invalid config");
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(text);
    expect(readLimitResumeSetting(root)).toBeUndefined();
  }
});

const oldApp =
  process.env.FULCRA_ROLLBACK_OLD_APP ??
  "/Users/user/fulcra-releases/live-candidate-13/app/Fulcra.app";
const oldExecutable = path.join(oldApp, "Contents/MacOS/Fulcra");
test.runIf(process.platform === "darwin" && existsSync(oldExecutable))(
  "exact candidate13 reader accepts all six combined preferences and binary rollback/return",
  () => {
    const asar = path.join(oldApp, "Contents/Resources/app.asar");
    expect(createHash("sha256").update(readFileSync(asar)).digest("hex")).toBe(
      "c45c1ff45c6916620560140fa229a5157016a13031bc9011caac7d52f96d9114",
    );
    const root = home();
    const script = path.join(root, "old-reader.cjs");
    writeFileSync(
      script,
      `
const { createRequire } = require('node:module');
const path = require('node:path');
const [app, home] = process.argv.slice(2);
const req = createRequire(path.join(app, 'Contents/Resources/app.asar/package.json'));
const old = req(path.join(app, 'Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server/persisted-config.js'));
if (typeof old.readPersistedConfig !== 'function') throw Error('Old config oracle unavailable');
try { old.readPersistedConfig(home); console.log(JSON.stringify({accepted:true})); }
catch(error) { console.log(JSON.stringify({accepted:false,message:error.message})); }
`,
    );
    const readOld = () =>
      JSON.parse(
        execFileSync(oldExecutable, [script, oldApp, root], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          timeout: 10_000,
        }).trim(),
      );
    const baseline = {
      version: 1 as const,
      daemon: { listen: "127.0.0.1:6767", appendSystemPrompt: "identity-preserved" },
      app: { baseUrl: "https://fixture.invalid" },
    };
    savePersistedConfig(root, baseline);
    expect(readOld()).toEqual({ accepted: true });
    console.info(
      "state-before",
      JSON.stringify({
        main: JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")),
        preference: readLimitResumeSetting(root) ?? "absent",
        oldReaderAccepted: true,
      }),
    );
    // Positive baseline precedes the captured negative oracle: unavailable exports never count as rejection.
    for (const enabled of [false, true]) {
      writeFileSync(
        path.join(root, "config.json"),
        JSON.stringify({ ...baseline, daemon: { ...baseline.daemon, autoResumeOnLimit: enabled } }),
      );
      const rejected = readOld();
      expect(rejected.accepted).toBe(false);
      expect(rejected.message).toContain('Unrecognized key: "autoResumeOnLimit"');
    }
    savePersistedConfig(root, baseline);
    const store = new DaemonConfigStore(root, initial());
    for (const { mode, enabled } of (["all", "off", "primes"] as const).flatMap((selectedMode) =>
      [false, true].map((selectedResume) => ({ mode: selectedMode, enabled: selectedResume })),
    )) {
      expect(store.patch({ notificationMode: mode, autoResumeOnLimit: enabled })).toMatchObject({
        notificationMode: mode,
        autoResumeOnLimit: enabled,
      });
      const bytes = readFileSync(path.join(root, "config.json"), "utf8");
      expect(readOld()).toEqual({ accepted: true }); // old binary reads retained new state, with no state restore.
      expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(bytes);
      expect(new DaemonConfigStore(root, initial()).get().autoResumeOnLimit).toBe(enabled);
      expect(loadConfig(root, { env: {} })).toMatchObject({
        notificationMode: mode,
        autoResumeOnLimit: enabled,
      });
      expect(readNotificationSetting(root)).toBe(mode);
      expect(JSON.parse(bytes).daemon.notificationMode).toBeUndefined();
      expect(JSON.parse(bytes).daemon.autoResumeOnLimit).toBeUndefined();
      console.info(
        "state-after",
        JSON.stringify({
          main: JSON.parse(bytes),
          preference: readLimitResumeSetting(root),
          notificationMode: readNotificationSetting(root),
          newReaderPreference: new DaemonConfigStore(root, initial()).get().autoResumeOnLimit,
          oldReaderAccepted: true,
        }),
      );
    }
  },
);

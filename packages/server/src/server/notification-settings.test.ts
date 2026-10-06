import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  statSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "./daemon-config-store.js";
import {
  loadPersistedConfig,
  readPersistedConfig,
  savePersistedConfig,
  editPersistedConfig,
} from "./persisted-config.js";
import { loadConfig } from "./config.js";
import {
  notificationSettingsPath,
  readNotificationSetting,
  writeNotificationSetting,
} from "./notification-settings.js";
import { readLimitResumeSetting } from "./limit-resume-settings.js";
const fault = vi.hoisted(() => ({ secondWrite: false, mainWrite: false }));
vi.mock("./private-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./private-files.js")>();
  return {
    ...original,
    writePrivateFileAtomicSync: (
      ...args: Parameters<typeof original.writePrivateFileAtomicSync>
    ) => {
      if (fault.secondWrite && args[0].endsWith("limit-resume/settings.json")) {
        fault.secondWrite = false;
        throw Error("fixture second sidecar write refused");
      }
      if (fault.mainWrite && args[0].endsWith("/config.json")) {
        fault.mainWrite = false;
        throw Error("fixture main write refused");
      }
      return original.writePrivateFileAtomicSync(...args);
    },
  };
});
const homes: string[] = [];
function home() {
  const root = mkdtempSync(path.join(tmpdir(), "notification-setting-compat-"));
  homes.push(root);
  return root;
}
const initial = () => MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } });
afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});
const combinations = (["all", "off", "primes"] as const).flatMap((mode) =>
  [false, true].map((resume) => ({ mode, resume })),
);
test.each(combinations)(
  "combined preference $mode/$resume keeps old main bytes and new readback",
  ({ mode, resume }) => {
    const root = home();
    savePersistedConfig(root, {
      version: 1,
      daemon: { listen: "127.0.0.1:6767", appendSystemPrompt: "preserve" },
      integrations: { oauthClientIds: { drive: "fixture-public-client" } },
    });
    writeFileSync(path.join(root, "identity.fixture"), "preserved identity");
    const before = readFileSync(path.join(root, "config.json"), "utf8");
    const store = new DaemonConfigStore(root, initial());
    store.patch({ notificationMode: mode, autoResumeOnLimit: resume });
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
    expect(readFileSync(path.join(root, "identity.fixture"), "utf8")).toBe("preserved identity");
    expect(new DaemonConfigStore(root, initial()).get()).toMatchObject({
      notificationMode: mode,
      autoResumeOnLimit: resume,
    });
    expect(readPersistedConfig(root).daemon).toMatchObject({
      notificationMode: mode,
      autoResumeOnLimit: resume,
    });
    expect(loadConfig(root, { env: {} })).toMatchObject({
      notificationMode: mode,
      autoResumeOnLimit: resume,
    });
    expect(readLimitResumeSetting(root)).toBe(resume);
    if (process.platform !== "win32")
      expect(statSync(notificationSettingsPath(root)).mode & 0o777).toBe(0o600);
  },
);
test("absent defaults primes without writing a sidecar/main key", () => {
  const root = home();
  expect(readNotificationSetting(root)).toBeUndefined();
  expect(new DaemonConfigStore(root, initial()).get().notificationMode).toBe("primes");
  expect(
    JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).daemon.notificationMode,
  ).toBeUndefined();
  expect(readNotificationSetting(root)).toBeUndefined();
});
test.each(["all", "off", "primes"] as const)(
  "valid legacy %s migrates only known main keys, newer sidecar wins",
  (mode) => {
    const root = home();
    const main = {
      version: 1,
      daemon: {
        notificationMode: mode,
        autoResumeOnLimit: false,
        listen: "127.0.0.1:6767",
        appendSystemPrompt: "preserved",
      },
      agents: { providers: { codex: { enabled: false } } },
    };
    writeFileSync(path.join(root, "config.json"), JSON.stringify(main));
    expect(loadPersistedConfig(root).daemon?.notificationMode).toBe(mode);
    expect(readNotificationSetting(root)).toBe(mode);
    const raw = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
    expect(raw).toEqual({
      ...main,
      daemon: { listen: main.daemon.listen, appendSystemPrompt: "preserved" },
    });
    writeNotificationSetting(root, "off");
    writeFileSync(path.join(root, "config.json"), JSON.stringify(main));
    expect(loadPersistedConfig(root).daemon?.notificationMode).toBe("off");
  },
);
test("stale generic saves and unrelated patches preserve newer sidecar", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ notificationMode: "all" });
  const stale = loadPersistedConfig(root);
  writeNotificationSetting(root, "off");
  savePersistedConfig(root, { ...stale, app: { baseUrl: "https://fixture.invalid" } });
  store.patch({ appendSystemPrompt: "unrelated" });
  expect(readNotificationSetting(root)).toBe("off");
  expect(
    JSON.parse(readFileSync(path.join(root, "config.json"), "utf8")).daemon.notificationMode,
  ).toBeUndefined();
});
test("explicit same-default choice and CLI set/unset persist separately", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ notificationMode: "primes" });
  expect(readNotificationSetting(root)).toBe("primes");
  editPersistedConfig(root, "daemon.notificationMode", { value: "off" });
  expect(readNotificationSetting(root)).toBe("off");
  editPersistedConfig(root, "daemon.appendSystemPrompt", { value: "preserved" });
  expect(readNotificationSetting(root)).toBe("off");
  editPersistedConfig(root, "daemon.notificationMode", { unset: true });
  expect(readNotificationSetting(root)).toBe("primes");
});
test("failed owner application restores both durable preferences and main bytes", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ notificationMode: "all", autoResumeOnLimit: false });
  const before = readFileSync(path.join(root, "config.json"), "utf8");
  store.onApply(() => {
    throw Error("owner refused");
  });
  expect(() => store.patch({ notificationMode: "off", autoResumeOnLimit: true })).toThrow(
    "owner refused",
  );
  expect(new DaemonConfigStore(root, initial()).get()).toMatchObject({
    notificationMode: "all",
    autoResumeOnLimit: false,
  });
  expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
});
test("failed second sidecar write restores first rather than persisting half a patch", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ notificationMode: "all", autoResumeOnLimit: false });
  fault.secondWrite = true;
  expect(() => store.patch({ notificationMode: "off", autoResumeOnLimit: true })).toThrow(
    "fixture second sidecar write refused",
  );
  expect(readNotificationSetting(root)).toBe("all");
  expect(store.get().notificationMode).toBe("all");
});
test.each([
  "broken JSON",
  '{"v":1,"mode":"unknown"}',
  '{"v":2,"mode":"off"}',
  '{"v":1,"mode":"off","future":true}',
  "x".repeat(1025),
])("invalid/future sidecar refuses and preserves bytes", (text) => {
  const root = home();
  const file = notificationSettingsPath(root);
  mkdirSync(path.dirname(file));
  writeFileSync(file, text);
  expect(() => new DaemonConfigStore(root, initial())).toThrow(/notification preference/);
  expect(readFileSync(file, "utf8")).toBe(text);
});
test.each(["symlink", "hardlink"])("non-private file shape %s refuses", (shape) => {
  const root = home();
  const file = notificationSettingsPath(root);
  mkdirSync(path.dirname(file));
  const target = path.join(root, "target");
  writeFileSync(target, '{"v":1,"mode":"off"}');
  if (shape === "symlink") symlinkSync(target, file);
  else linkSync(target, file);
  expect(() => readNotificationSetting(root)).toThrow(/notification preference/);
});
test("malformed/future legacy main refuses without cleanup or sidecar", () => {
  const root = home();
  for (const daemon of [
    { notificationMode: "unknown" },
    { notificationMode: "off", futureField: true },
  ]) {
    const text = JSON.stringify({ daemon });
    writeFileSync(path.join(root, "config.json"), text);
    expect(() => loadPersistedConfig(root)).toThrow("Invalid config");
    expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(text);
    expect(readNotificationSetting(root)).toBeUndefined();
  }
});

test("failed combined main write restores both sidecars and unrelated main bytes", () => {
  const root = home();
  const store = new DaemonConfigStore(root, initial());
  store.patch({ notificationMode: "all", autoResumeOnLimit: false });
  const before = readFileSync(path.join(root, "config.json"), "utf8");
  fault.mainWrite = true;
  expect(() =>
    store.patch({
      notificationMode: "off",
      autoResumeOnLimit: true,
      appendSystemPrompt: "new text",
    }),
  ).toThrow("fixture main write refused");
  expect(readFileSync(path.join(root, "config.json"), "utf8")).toBe(before);
  expect(new DaemonConfigStore(root, initial()).get()).toMatchObject({
    notificationMode: "all",
    autoResumeOnLimit: false,
  });
});

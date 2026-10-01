import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_BOOT_FILE, daemonBootDenyRules, recordDaemonBoot } from "./daemon-boot.js";
import { TrustedPlugins, trustedClaudeDenyRules } from "./trusted.js";

const noop = () => undefined;
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "daemon-boot-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W1 row 9: daemon boot succession", () => {
  it("names the boot each boot replaced, privately", () => {
    const dir = home(),
      a = randomUUID(),
      b = randomUUID();
    expect(recordDaemonBoot(dir, a)).toBeNull();
    expect(recordDaemonBoot(dir, b)).toBe(a);
    expect(JSON.parse(readFileSync(path.join(dir, DAEMON_BOOT_FILE), "utf8"))).toEqual({
      v: 1,
      boot: b,
    });
    expect(statSync(path.join(dir, DAEMON_BOOT_FILE)).mode & 0o077).toBe(0);
  });

  it("a malformed record yields no predecessor", () => {
    const dir = home();
    writeFileSync(path.join(dir, DAEMON_BOOT_FILE), '{"v":1,"boot":"not-a-boot"}\n');
    expect(recordDaemonBoot(dir, randomUUID())).toBeNull();
  });

  it("an unwritable record returns null and leaves no stale predecessor for the next boot", () => {
    const dir = home(),
      a = randomUUID();
    recordDaemonBoot(dir, a);
    const b = randomUUID();
    mkdirSync(path.join(dir, `${DAEMON_BOOT_FILE}.${b}.tmp`)); // the temporary path is taken: the write fails
    expect(recordDaemonBoot(dir, b)).toBeNull();
    rmSync(path.join(dir, `${DAEMON_BOOT_FILE}.${b}.tmp`), { recursive: true });
    expect(recordDaemonBoot(dir, randomUUID())).toBeNull();
  });
});

describe("W1-1(d): the succession record is denied to agents", () => {
  it("every Claude query carries host rules for the record and its temporary siblings", () => {
    const dir = home(),
      host = new TrustedPlugins();
    host.initializeKnownAgents([]);
    host.registerV11("orca-organization-next", true, () => undefined);
    host.denyToAgents(daemonBootDenyRules(dir));
    const rules = trustedClaudeDenyRules(),
      file = path.join(dir, DAEMON_BOOT_FILE);
    for (const tool of ["Read", "Edit", "Write"]) {
      expect(rules).toContain(`${tool}(/${file})`);
      expect(rules).toContain(`${tool}(/${file}.*)`);
    }
    expect(rules).toContain(`Bash(*${file}*)`);
    host.close();
    expect(trustedClaudeDenyRules()).not.toContain(`Bash(*${file}*)`);
  });

  // Review delta W1-1(d): the reviewer's reach cases, kept permanently.
  const linkedHome = () => {
    const real = home(),
      link = path.join(home(), "home");
    symlinkSync(real, link);
    return { real: realpathSync(real), link };
  };
  it("with NO trusted plugin registered (no controller distribution) the rule still reaches the query", () => {
    const { link } = linkedHome(),
      host = new TrustedPlugins();
    host.initializeKnownAgents([]);
    host.denyToAgents(daemonBootDenyRules(link));
    expect(trustedClaudeDenyRules()).toContain(`Bash(*${path.join(link, DAEMON_BOOT_FILE)}*)`);
    host.close();
  });

  it("covers the given AND the resolved PASEO_HOME", () => {
    const { real, link } = linkedHome(),
      host = new TrustedPlugins();
    host.initializeKnownAgents([]);
    host.denyToAgents(daemonBootDenyRules(link));
    const rules = trustedClaudeDenyRules();
    for (const dir of [link, real]) {
      const file = path.join(dir, DAEMON_BOOT_FILE);
      expect(rules).toContain(`Bash(*${file}*)`);
      for (const tool of ["Read", "Edit", "Write"]) expect(rules).toContain(`${tool}(/${file}.*)`);
    }
    host.close();
  });

  it("bootstrap installs the rule right after recording the boot", () => {
    const text = readFileSync(path.join(__dirname, "../bootstrap.ts"), "utf8");
    const record = text.indexOf("recordDaemonBoot(config.paseoHome, trustedPlugins.boot)");
    expect(record).toBeGreaterThan(0);
    expect(
      text.indexOf("trustedPlugins.denyToAgents(daemonBootDenyRules(config.paseoHome))"),
    ).toBeGreaterThan(record);
  });
});

describe("W1 row 9: clean-exit seal inputs", () => {
  it("snapshots only human-input counters, absent meaning zero", () => {
    const host = new TrustedPlugins();
    const id = randomUUID();
    host.initializeKnownAgents([id, randomUUID()]);
    expect(host.humanInputSnapshot()).toEqual({});
    const agent = { id, provider: "claude" } as never;
    const cancel = () => host.input(agent, "cancel", undefined, noop);
    host.rpc(undefined, cancel);
    host.daemon(cancel);
    expect(host.humanInputSnapshot()).toEqual({ [id]: 1 });
    host.close();
  });

  it("bootstrap seals synchronously immediately before the host closes, after the shutdown closure", () => {
    const text = readFileSync(path.join(__dirname, "../bootstrap.ts"), "utf8");
    const stop = text.slice(text.indexOf("const stop = async () => {"));
    const closure = stop.indexOf("closeAllAgents(logger, agentManager)");
    const seal = stop.indexOf("distribution?.sealBoot?.(");
    const close = stop.indexOf("trustedPlugins.close();");
    expect(closure).toBeGreaterThan(0);
    expect(seal).toBeGreaterThan(closure);
    expect(close).toBeGreaterThan(seal);
    expect(stop.slice(seal, close)).not.toContain("await");
    expect(text.split("distribution?.sealBoot?.(").length).toBe(2);
  });

  it("shutdownClosure has exactly one caller: bootstrap stop() around closeAllAgents", () => {
    const root = path.join(__dirname, "..");
    const callers: string[][] = [];
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      for (const line of readFileSync(path.join(root, file), "utf8").split("\n"))
        if (line.includes(".shutdownClosure(")) callers.push([file, line.trim()]);
    }
    expect(callers).toEqual([
      [
        "bootstrap.ts",
        "await trustedPlugins.shutdownClosure(() => closeAllAgents(logger, agentManager));",
      ],
    ]);
    const text = readFileSync(path.join(root, "bootstrap.ts"), "utf8");
    expect(text.indexOf(".shutdownClosure(")).toBeGreaterThan(
      text.indexOf("const stop = async () => {"),
    );
    expect(text).not.toContain("trustedPlugins.daemon(() => closeAllAgents");
  });
});

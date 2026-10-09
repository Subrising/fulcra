import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { TrustedPlugins } from "./trusted.js";
import { ControlStore } from "../../../../../control/src/control/store.mjs";
import { createTrustedContribution } from "../../../../../control/src/control/trusted-contribution.mjs";

const A = "11111111-1111-4111-8111-111111111111";

function host(
  setup?: (server: Parameters<Parameters<TrustedPlugins["registerV11"]>[2]>[0]) => void,
) {
  const plugins = new TrustedPlugins();
  plugins.initializeKnownAgents([]);
  if (setup) plugins.registerV11("fixture", true, setup);
  return plugins;
}

test("with no trusted input authority, the host may resume a session on its own", () => {
  expect(host().mayResumeUnscoped(A)).toBe(true);
  expect(host(() => undefined).mayResumeUnscoped(A)).toBe(true);
});

test("an input authority that does not answer blocks every automatic resume", () => {
  const plugins = host((server) => server.admission.onInput(() => "allow"));
  expect(plugins.mayResumeUnscoped(A)).toBe(false);
});

test("an input authority decides per session; only a plain false lets the host resume", () => {
  const owned = new Set([A]);
  const plugins = host((server) => {
    server.admission.onInput(() => "allow");
    server.admission.ownsSession?.((agentId) => owned.has(agentId));
  });
  expect(plugins.mayResumeUnscoped(A)).toBe(false);
  expect(plugins.mayResumeUnscoped("22222222-2222-4222-8222-222222222222")).toBe(true);
});

test("a throw or a non-boolean answer counts as owned", () => {
  const throwing = host((server) => {
    server.admission.onInput(() => "allow");
    server.admission.ownsSession?.(() => {
      throw new Error("store unreadable");
    });
  });
  expect(throwing.mayResumeUnscoped(A)).toBe(false);
  const vague = host((server) => {
    server.admission.onInput(() => "allow");
    server.admission.ownsSession?.(() => undefined as unknown as boolean);
  });
  expect(vague.mayResumeUnscoped(A)).toBe(false);
});

test("an answer is registered once, during setup only", () => {
  let late: ((handler: (agentId: string) => boolean) => void) | undefined;
  const free = () => false;
  const plugins = host((server) => {
    server.admission.onInput(() => "allow");
    server.admission.ownsSession?.(free);
    expect(() => server.admission.ownsSession?.(free)).toThrow();
    late = server.admission.ownsSession;
  });
  expect(() => late?.(() => false)).toThrow();
  expect(plugins.mayResumeUnscoped(A)).toBe(true);
});

test("the Command Centre controller claims the sessions in its journal and leaves others to the host", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "resume-ownership-"));
  const store = new ControlStore(path.join(home, "journal.sqlite"));
  try {
    const plugins = host((server) => createTrustedContribution({ home })(server));
    const delegated = "33333333-3333-4333-8333-333333333333";
    const human = "44444444-4444-4444-8444-444444444444";
    const standalone = "55555555-5555-4555-8555-555555555555";
    store.created(delegated, randomUUID(), home);
    store.db.prepare("UPDATE sessions SET mode='delegated' WHERE id=?").run(delegated);
    store.created(human, randomUUID(), home);
    store.db.prepare("UPDATE sessions SET mode='human' WHERE id=?").run(human);
    expect(plugins.mayResumeUnscoped(delegated)).toBe(false);
    expect(plugins.mayResumeUnscoped(human)).toBe(false);
    expect(plugins.mayResumeUnscoped(standalone)).toBe(true);
    // An unreadable journal claims every session (fail closed).
    store.close();
    await rm(path.join(home, "journal.sqlite"), { force: true });
    await writeFile(path.join(home, "journal.sqlite"), "not a database");
    expect(plugins.mayResumeUnscoped(standalone)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

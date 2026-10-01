import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  intercomRateSettingsGetRpc,
  intercomRateSettingsRpc,
  intercomStatusRpc,
  reportParentAdoptRpc,
} from "./intercom";

test("intercom app contracts: explicit finite owner save, protected reads and no credential/label projection", () => {
  expect(intercomRateSettingsGetRpc.input.parse({})).toEqual({});
  expect(() => intercomRateSettingsGetRpc.input.parse({ report: true })).toThrow();
  expect(
    intercomRateSettingsGetRpc.output.parse({
      initialized: false,
      settings: null,
      windowMs: 3600000,
    }),
  ).toMatchObject({ initialized: false });
  const settings = { report: 12, followup: 64, channel: 64, seat: 32 };
  expect(
    intercomRateSettingsRpc.input.parse({ messageId: randomUUID(), settings }).settings,
  ).toEqual(settings);
  expect(() =>
    intercomRateSettingsRpc.input.parse({
      messageId: randomUUID(),
      settings: { ...settings, report: 13 },
    }),
  ).toThrow();
  const identity = {
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: "fixture-native",
    boot: randomUUID(),
  };
  const status = {
    version: 1,
    identity,
    registration: null,
    queueAvailable: false,
    reportLinked: false,
    settingsInitialized: false,
    supportedProviders: ["codex"],
  };
  expect(intercomStatusRpc.output.parse(status).queueAvailable).toBe(false);
  expect(() =>
    intercomStatusRpc.output.parse({
      ...status,
      reportCredential: "report1.forged",
    }),
  ).toThrow();
  expect(() =>
    intercomStatusRpc.output.parse({
      ...status,
      supportedProviders: ["codex", "claude"],
    }),
  ).toThrow();
  expect(() => intercomStatusRpc.input.parse({ agentId: identity.agentId, owner: true })).toThrow();
  expect(() =>
    reportParentAdoptRpc.input.parse({
      messageId: randomUUID(),
      child: identity,
      parent: identity,
      labels: { parent: identity.agentId },
      expectedEpoch: null,
      scopes: [],
    }),
  ).toThrow();
});

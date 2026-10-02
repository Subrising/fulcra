import { expect, test } from "vitest";
import { permissionFacts, runtimeFacts } from "./trusted-facts.js";
import { sanitizePendingPermissions } from "../agent/agent-projections.js";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

test("P2: golden permission projection preserves wire omission, Date, suggestions and actions", () => {
  const request: AgentPermissionRequest = {
    id: "request",
    provider: "claude",
    kind: "tool",
    name: "Write",
    input: {
      file_path: "/fixture/owned",
      at: new Date("2030-01-01T00:00:00Z"),
      omit: undefined,
      empty: {},
    },
    metadata: { generation: 7, root: "/fixture" },
    suggestions: [{}, { mode: "allowed" }],
    actions: [{ id: "accept", label: "Allow", behavior: "allow", intent: "implement" }],
  };
  const pending = new Map([["request", request]]);
  const inFlight = new Set(["other"]);
  const snapshot = permissionFacts({
    pendingPermissions: pending,
    inFlightPermissionResponses: inFlight,
  });
  const expected = [
    {
      id: "request",
      provider: "claude",
      kind: "tool",
      name: "Write",
      input: { file_path: "/fixture/owned", at: "2030-01-01T00:00:00.000Z" },
      metadata: { generation: 7, root: "/fixture" },
      suggestions: [{ mode: "allowed" }],
      actions: [{ id: "accept", label: "Allow", behavior: "allow", intent: "implement" }],
    },
  ];
  expect(JSON.parse(JSON.stringify(sanitizePendingPermissions(pending)))).toEqual(expected);
  expect(snapshot).toEqual({ status: "known", requests: expected, inFlightRequestIds: ["other"] });
  request.actions![0].label = "Changed";
  inFlight.add("later");
  expect(snapshot).toEqual({ status: "known", requests: expected, inFlightRequestIds: ["other"] });
});

test("P2/P3: incomplete permission and stored runtime facts remain unavailable", () => {
  expect(permissionFacts({ pendingPermissions: new Map() })).toEqual({ status: "unavailable" });
  expect(
    permissionFacts({
      pendingPermissions: new Map([["different", { id: "request" }]]),
      inFlightPermissionResponses: new Set(),
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    runtimeFacts({ config: { model: "expected" }, persistence: { sessionId: "old" } }),
  ).toEqual({ status: "unavailable" });
  expect(
    runtimeFacts({
      provider: "claude",
      instanceId: "instance",
      features: [],
      lastUserMessageAt: "invalid",
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    runtimeFacts({
      provider: "claude",
      instanceId: "instance",
      features: [],
      lastUserMessageAt: null,
    }),
  ).toEqual({
    status: "known",
    instanceId: "instance",
    nativeSessionId: null,
    model: null,
    serviceTier: null,
    lastUserMessageAt: null,
  });
});

test("P3: a closed live-instance descriptor cannot assert current runtime or permission state", () => {
  const previous = {
    provider: "claude",
    instanceId: "instance",
    lastUserMessageAt: null,
    features: [],
    pendingPermissions: new Map(),
    inFlightPermissionResponses: new Set<string>(),
  };
  for (const closed of [
    { ...previous, lifecycle: "closed" },
    { ...previous, session: null },
  ]) {
    expect(runtimeFacts(closed)).toEqual({ status: "unavailable" });
    expect(permissionFacts(closed)).toEqual({ status: "unavailable" });
  }
});

test("U7 runtime reports the current permission mode ahead of saved config", () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- fixture is mutated with out-of-contract values below
  const a: any = {
    provider: "claude",
    instanceId: "instance",
    lastUserMessageAt: null,
    runtimeInfo: { sessionId: "native", model: "fixture" },
    currentModeId: "auto",
    config: { modeId: "default" },
  };
  expect(runtimeFacts(a)).toMatchObject({ status: "known", modeId: "auto" });
  a.currentModeId = "default";
  expect(runtimeFacts(a)).toMatchObject({ status: "known", modeId: "default" });
});

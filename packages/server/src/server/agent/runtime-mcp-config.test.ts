import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import {
  withRuntimePaseoMcpServer,
  matchesPaseoInjectLabels,
  assertPaseoInjectionLabelWrite,
} from "./runtime-mcp-config.js";

const BASE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/tmp/agent",
};

describe("withRuntimePaseoMcpServer", () => {
  test("injects the paseo MCP server with a bearer header when a token is provided", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
      headers: { Authorization: "Bearer cap-token" },
    });
  });

  test("omits the header when no token is available", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
      mcpAuthToken: null,
    });

    expect(result.mcpServers?.paseo).toEqual({
      type: "http",
      url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-1",
    });
  });

  test("does not inject when no MCP base URL is configured", () => {
    const result = withRuntimePaseoMcpServer({
      config: BASE_CONFIG,
      agentId: "agent-1",
      mcpBaseUrl: null,
      mcpAuthToken: "cap-token",
    });

    expect(result.mcpServers).toBeUndefined();
  });
});

test("MCP injection requires every configured label, with exact own values", () => {
  expect(matchesPaseoInjectLabels(undefined, {})).toBe(true);
  expect(matchesPaseoInjectLabels({}, {})).toBe(true);
  const required = { "fulcra.mcp": "on", role: "lead" };
  expect(matchesPaseoInjectLabels({ ...required, extra: "value" }, required)).toBe(true);
  expect(matchesPaseoInjectLabels(undefined, required)).toBe(false);
  expect(matchesPaseoInjectLabels({ "fulcra.mcp": "on" }, required)).toBe(false);
  expect(matchesPaseoInjectLabels({ ...required, role: "Lead" }, required)).toBe(false);
  expect(matchesPaseoInjectLabels(Object.create(required), required)).toBe(false);
});

describe("reserved MCP injection labels", () => {
  const required = { "fulcra.mcp": "on", team: "lead" };
  test("workers cannot set any reserved key, even to a non-matching value", () => {
    for (const labels of [{ "fulcra.mcp": "on" }, { team: "worker" }]) {
      expect(() =>
        assertPaseoInjectionLabelWrite({
          labels,
          required,
          callerAgentId: "worker",
          callerLabels: {},
          agentInput: true,
        }),
      ).toThrow("MCP token filter labels are reserved");
    }
  });
  test("a lead must already match every key", () => {
    expect(() =>
      assertPaseoInjectionLabelWrite({
        labels: required,
        required,
        callerAgentId: "lead",
        callerLabels: { "fulcra.mcp": "on" },
        agentInput: true,
      }),
    ).toThrow("MCP token filter labels are reserved");
    expect(() =>
      assertPaseoInjectionLabelWrite({
        labels: required,
        required,
        callerAgentId: "lead",
        callerLabels: required,
        agentInput: true,
      }),
    ).not.toThrow();
  });
  test("a user can set reserved keys; anonymous agent input cannot", () => {
    expect(() =>
      assertPaseoInjectionLabelWrite({ labels: required, required, agentInput: false }),
    ).not.toThrow();
    expect(() =>
      assertPaseoInjectionLabelWrite({ labels: required, required, agentInput: true }),
    ).toThrow("MCP token filter labels are reserved");
  });
  test("an empty filter still protects MCP selection; ordinary labels keep their behavior", () => {
    expect(() =>
      assertPaseoInjectionLabelWrite({ labels: required, required: {}, agentInput: true }),
    ).toThrow("reserved");
    expect(() =>
      assertPaseoInjectionLabelWrite({ labels: { phase: "test" }, required, agentInput: true }),
    ).not.toThrow();
  });
});

test("lead matches the old on gate while other injection requirements stay exact", () => {
  const required = { "fulcra.mcp": "on", team: "lead" };
  expect(matchesPaseoInjectLabels({ "fulcra.mcp": "lead", team: "lead" }, required)).toBe(true);
  for (const labels of [
    { "fulcra.mcp": "off", team: "lead" },
    { "fulcra.mcp": "lead" },
    { team: "lead" },
  ])
    expect(matchesPaseoInjectLabels(labels, required)).toBe(false);
  expect(matchesPaseoInjectLabels({ "fulcra.mcp": "on" }, { "fulcra.mcp": "lead" })).toBe(false);
});

test("preset and group writes are reserved even without a configured filter", () => {
  for (const labels of [{ "fulcra.mcp": "lead" }, { "fulcra.mcp.groups": "browser" }]) {
    expect(() =>
      assertPaseoInjectionLabelWrite({
        labels,
        required: {},
        agentInput: true,
        callerAgentId: "worker",
        callerLabels: {},
      }),
    ).toThrow("reserved");
    expect(() =>
      assertPaseoInjectionLabelWrite({ labels, required: {}, agentInput: false }),
    ).not.toThrow();
    expect(() =>
      assertPaseoInjectionLabelWrite({
        labels,
        required: {},
        agentInput: true,
        callerAgentId: "lead",
        callerLabels: { "fulcra.mcp": "lead" },
      }),
    ).not.toThrow();
  }
});

test("workers cannot acquire lead authority through on with an empty injection filter", () => {
  for (const labels of [
    { "fulcra.mcp": "on" },
    { "fulcra.mcp": "lead" },
    { "fulcra.mcp.groups": "browser" },
    { "fulcra.mcp": null },
  ])
    expect(() =>
      assertPaseoInjectionLabelWrite({
        labels,
        required: {},
        agentInput: true,
        callerAgentId: "worker",
        callerLabels: {},
      }),
    ).toThrow("reserved");
});

import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { withRuntimePaseoMcpServer, matchesPaseoInjectLabels } from "./runtime-mcp-config.js";

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

import { describe, expect, test } from "vitest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import {
  isPaseoToolEnabled,
  resolvePaseoToolPolicy,
  sessionPaseoToolPolicy,
} from "./paseo-tool-policy.js";

describe("Paseo tool policy", () => {
  test("defaults to all Paseo tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderPaseoToolsPolicy;

    expect(
      resolvePaseoToolPolicy("custom-claude", {
        claude: { paseoTools: { enabled: false } },
        "custom-claude": { paseoTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolvePaseoToolPolicy("other-custom", { claude: { paseoTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isPaseoToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isPaseoToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isPaseoToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });
});

test("the lead preset contains exactly the daily tools and intersects provider limits", () => {
  const lead = sessionPaseoToolPolicy(undefined, { "fulcra.mcp": "lead" });
  expect(lead?.allowedTools).toHaveLength(12);
  for (const name of [
    "create_agent",
    "send_agent_prompt",
    "archive_agent",
    "supervisor_inbox",
    "supervisor_acknowledge",
    "respond_to_permission",
  ])
    expect(isPaseoToolEnabled(lead, name)).toBe(true);
  for (const name of ["browser_list_tabs", "create_terminal", "future_tool", "kill_agent"])
    expect(isPaseoToolEnabled(lead, name)).toBe(false);
  const limited = sessionPaseoToolPolicy(
    { allowedTools: ["create_agent", "list_agents"], disabledTools: ["list_agents"] },
    { "fulcra.mcp": "lead" },
  );
  expect(isPaseoToolEnabled(limited, "create_agent")).toBe(true);
  expect(isPaseoToolEnabled(limited, "list_agents")).toBe(false);
  expect(isPaseoToolEnabled(limited, "archive_agent")).toBe(false);
  expect(
    isPaseoToolEnabled(
      sessionPaseoToolPolicy({ enabled: false }, { "fulcra.mcp": "lead" }),
      "create_agent",
    ),
  ).toBe(false);
});

test("groups add only named optional tools and reject unknown selections", () => {
  const labels = {
    "fulcra.mcp": "lead",
    "fulcra.mcp.groups": "browser,terminals,schedules,workspaces",
  };
  const policy = sessionPaseoToolPolicy(undefined, labels);
  expect(policy?.allowedTools).toHaveLength(52);
  expect(isPaseoToolEnabled(policy, "browser_click")).toBe(true);
  expect(isPaseoToolEnabled(policy, "create_terminal")).toBe(true);
  expect(isPaseoToolEnabled(policy, "create_schedule")).toBe(true);
  expect(isPaseoToolEnabled(policy, "archive_workspace")).toBe(true);
  expect(isPaseoToolEnabled(policy, "kill_agent")).toBe(false);
  expect(() =>
    sessionPaseoToolPolicy(undefined, { ...labels, "fulcra.mcp.groups": "future" }),
  ).toThrow("Unknown");
  expect(() => sessionPaseoToolPolicy(undefined, { "fulcra.mcp.groups": "browser" })).toThrow(
    "require",
  );
  expect(sessionPaseoToolPolicy(undefined, { "fulcra.mcp": "on" })).toBeUndefined();
});

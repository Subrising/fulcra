import { describe, expect, it } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { SESSION_DEFAULTS_RPC, SESSION_ROLE_LABEL } from "@getpaseo/protocol/session-roles";
import {
  availableRoles,
  describeRoleDefault,
  mergeRoleInitialValues,
  parseSessionDefaults,
  roleInitialValues,
  roleLabels,
  selectedDraftRole,
} from "./role-defaults";

// The plugin's answer for the approved table on a host whose Claude offers Opus 5.5 but not
// Sonnet 5.5: implementation falls back to the provider's own default.
const SERVED = {
  roles: {
    planning: {
      provider: null,
      providers: {
        claude: {
          status: "offered",
          configured: { model: "claude-opus-5-5", thinkingOptionId: "high" },
          effective: { model: "claude-opus-5-5", thinkingOptionId: "high" },
        },
      },
    },
    orchestration: {
      provider: null,
      providers: {
        claude: {
          status: "unknown",
          configured: { model: "claude-opus-5-5", thinkingOptionId: "medium" },
          effective: null,
        },
      },
    },
    implementation: {
      provider: "claude",
      providers: {
        claude: {
          status: "falls-back",
          configured: { model: "claude-sonnet-5-5", thinkingOptionId: "high" },
          effective: { model: "claude", thinkingOptionId: "high" },
        },
      },
    },
  },
};
const OPUS: AgentModelDefinition = {
  provider: "claude",
  id: "claude-opus-5-5",
  label: "Opus 5.5",
  thinkingOptions: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
};

describe("session role defaults", () => {
  it("pins the cross-tree names the organization plugin asserts", () => {
    expect(SESSION_ROLE_LABEL).toBe("fulcra.role");
    expect(SESSION_DEFAULTS_RPC).toBe("organization.session-defaults");
  });

  it("reads the served table, and treats any other shape as no role defaults", () => {
    const table = parseSessionDefaults(SERVED);
    expect(availableRoles(table)).toEqual(["planning", "orchestration", "implementation"]);
    expect(parseSessionDefaults({ roles: {} })).toEqual({ roles: {} });
    expect(availableRoles(parseSessionDefaults({ roles: {} }))).toEqual([]);
    for (const bad of [
      null,
      "x",
      { roles: [] },
      { roles: { planning: { provider: 3, providers: {} } } },
      { roles: { planning: { provider: null, providers: { claude: { status: "maybe" } } } } },
    ]) {
      expect(parseSessionDefaults(bad)).toBeNull();
    }
    expect(availableRoles(null)).toEqual([]);
  });

  it("pre-fills what a creation under the role would launch here", () => {
    const table = parseSessionDefaults(SERVED);
    expect(roleInitialValues({ role: "planning", table, provider: "claude" })).toEqual({
      model: "claude-opus-5-5",
      thinkingOptionId: "high",
    });
    // Not checked here: what is configured is all that is known.
    expect(roleInitialValues({ role: "orchestration", table, provider: "claude" })).toEqual({
      model: "claude-opus-5-5",
      thinkingOptionId: "medium",
    });
    // Falls back to the provider's own default model: no model is pinned; the role names its provider.
    expect(roleInitialValues({ role: "implementation", table, provider: "codex" })).toEqual({
      provider: "claude",
      thinkingOptionId: "high",
    });
  });

  it("contributes nothing without a role, a table, or an entry for the provider in use", () => {
    const table = parseSessionDefaults(SERVED);
    expect(roleInitialValues({ role: null, table, provider: "claude" })).toBeUndefined();
    expect(
      roleInitialValues({ role: "planning", table: null, provider: "claude" }),
    ).toBeUndefined();
    expect(roleInitialValues({ role: "planning", table, provider: "codex" })).toBeUndefined();
    expect(roleLabels(null)).toBeUndefined();
    expect(roleLabels("planning")).toEqual({ "fulcra.role": "planning" });
  });

  it("lets explicit setup values win and fills only what they leave unset", () => {
    const role = { model: "claude-opus-5-5", thinkingOptionId: "high" };
    expect(mergeRoleInitialValues(undefined, role)).toEqual(role);
    expect(mergeRoleInitialValues({ provider: "claude" }, undefined)).toEqual({
      provider: "claude",
    });
    expect(
      mergeRoleInitialValues(
        { provider: "claude", model: "claude-sonnet-5", thinkingOptionId: null },
        role,
      ),
    ).toEqual({ provider: "claude", model: "claude-sonnet-5", thinkingOptionId: "high" });
  });

  it("describes the default in the words the picker shows", () => {
    expect(
      describeRoleDefault({
        values: { model: "claude-opus-5-5", thinkingOptionId: "high" },
        models: [OPUS],
      }),
    ).toEqual({ model: "Opus 5.5", effort: "high" });
    expect(
      describeRoleDefault({
        values: { model: "claude-x", thinkingOptionId: null },
        models: [OPUS],
      }),
    ).toEqual({ model: "claude-x", effort: null });
    expect(
      describeRoleDefault({ values: { thinkingOptionId: "high" }, models: [OPUS] }),
    ).toBeNull();
  });
});

// Update-7 W3 (owner, 01:29Z) + R1 W3-1: the form pre-fills the host's default permission mode, and a fresh draft is an
// Implementation session until the user picks, so the UI new-session path gets the role default too.
describe("W3: default permission modes and the default role", () => {
  it("parses the served modes and pre-fills the provider's mode, with or without a role", () => {
    const table = parseSessionDefaults({
      ...SERVED,
      modes: { claude: "auto", codex: "full-access" },
    });
    expect(table?.modes).toEqual({ claude: "auto", codex: "full-access" });
    expect(roleInitialValues({ role: null, table, provider: "codex" })).toEqual({
      modeId: "full-access",
    });
    expect(roleInitialValues({ role: "implementation", table, provider: "claude" })).toMatchObject({
      modeId: "auto",
    });
    expect(parseSessionDefaults(SERVED)?.modes).toBeUndefined();
    expect(parseSessionDefaults({ ...SERVED, modes: { codex: 7 } })?.modes).toEqual({});
  });

  it("a draft with no remembered choice is Implementation; an explicit No role is kept", () => {
    const choices = availableRoles(parseSessionDefaults(SERVED));
    expect(selectedDraftRole({}, choices)).toBe("implementation");
    expect(selectedDraftRole({ role: "planning", roleChosen: true }, choices)).toBe("planning");
    expect(selectedDraftRole({ roleChosen: true }, choices)).toBeNull();
    expect(selectedDraftRole({}, [])).toBeNull();
    expect(
      selectedDraftRole({ role: "planning", roleChosen: true }, ["implementation"]),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  childModeClass,
  resolveAndValidateCreateAgentMode,
  resolveOwnDefaultCreateConfig,
} from "./create-agent-mode.js";

const CLAUDE_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];
const OPENCODE_MODES = ["build", "plan"];
const CODEX_MODES = ["auto", "full-access"];

function agentParent(provider: string, modeId: string | null, isUnattended = false) {
  return { provider, modeId, isUnattended };
}

describe("resolveAndValidateCreateAgentMode", () => {
  it("returns the requested mode when it is valid for the target provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "plan",
      targetProvider: "opencode",
      parent: null,
      unattended: false,
      availableModes: OPENCODE_MODES,
    });
    expect(resolved).toBe("plan");
  });

  it("throws when the requested mode is invalid for the target provider", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: "bypassPermissions",
        targetProvider: "opencode",
        parent: null,
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "Invalid mode 'bypassPermissions' for provider 'opencode'. Available modes: build, plan",
    );
  });

  it("selects the adapter's declared automatic-approval mode when no mode and no caller", () => {
    // Claude's declared automatic mode is the classifier, and it must be offered by the
    // live adapter to be selected.
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "claude",
        parent: null,
        unattended: false,
        availableModes: [...CLAUDE_MODES, "auto"],
      }),
    ).toBe("auto");
    // Never Bypass, whatever the adapter offers.
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "claude",
        parent: null,
        unattended: false,
        availableModes: [...CLAUDE_MODES, "auto"],
      }),
    ).not.toBe("bypassPermissions");
    // Codex takes auto-review, not the mode named "auto".
    expect(
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: null,
        unattended: false,
        availableModes: [...CODEX_MODES, "auto-review"],
      }),
    ).toBe("auto-review");
  });

  it("falls back to the provider default when the adapter offers no automatic mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: null,
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("inherits the caller mode when caller and target share a provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", "bypassPermissions"),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBe("bypassPermissions");
  });

  it("returns undefined when same-provider caller has no mode", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "claude",
      parent: agentParent("claude", null),
      unattended: false,
      availableModes: CLAUDE_MODES,
    });
    expect(resolved).toBeUndefined();
  });

  it("refuses cross-provider inheritance with the target provider's modes in the message", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "opencode",
        parent: agentParent("claude", "bypassPermissions"),
        unattended: false,
        availableModes: OPENCODE_MODES,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'opencode'). Pass an explicit mode. Available modes for 'opencode': build, plan",
    );
  });

  it("refuses cross-provider inheritance even when the caller mode is null", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("opencode", null),
        unattended: false,
        availableModes: CODEX_MODES,
      }),
    ).toThrow(
      "cannot inherit mode '<none>' from caller (provider 'opencode') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("uses the provider default when the cross-provider target has no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("codex", "auto"),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("uses the provider default when an unattended parent targets a provider with no modes", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "pi",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: [],
      targetUnattendedMode: undefined,
    });

    expect(resolved).toBeUndefined();
  });

  it("passes through an explicit mode when the target provider's modes are unknown", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "default",
      targetProvider: "zai-custom",
      parent: null,
      unattended: false,
      availableModes: undefined,
    });
    expect(resolved).toBe("default");
  });

  it("renders 'unknown' in cross-provider error when target modes are unknown", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: undefined,
      }),
    ).toThrow("Available modes for 'zai-custom': unknown");
  });

  it("inherits target's unattended mode when caller is unattended cross-provider", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("inherits target's unattended mode for unattended creation without a parent", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: undefined,
      targetProvider: "codex",
      parent: null,
      unattended: true,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("full-access");
  });

  it("still refuses cross-provider inheritance when caller is not unattended", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "codex",
        parent: agentParent("claude", "default"),
        unattended: false,
        availableModes: CODEX_MODES,
        targetUnattendedMode: "full-access",
      }),
    ).toThrow(
      "cannot inherit mode 'default' from caller (provider 'claude') for new agent (provider 'codex'). Pass an explicit mode. Available modes for 'codex': auto, full-access",
    );
  });

  it("still refuses cross-provider inheritance when target has no unattended mode", () => {
    expect(() =>
      resolveAndValidateCreateAgentMode({
        requestedMode: undefined,
        targetProvider: "zai-custom",
        parent: agentParent("claude", "bypassPermissions", true),
        unattended: false,
        availableModes: undefined,
        targetUnattendedMode: undefined,
      }),
    ).toThrow(
      "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'zai-custom'). Pass an explicit mode. Available modes for 'zai-custom': unknown",
    );
  });

  it("explicit mode wins over unattended inheritance", () => {
    const resolved = resolveAndValidateCreateAgentMode({
      requestedMode: "auto",
      targetProvider: "codex",
      parent: agentParent("claude", "bypassPermissions", true),
      unattended: false,
      availableModes: CODEX_MODES,
      targetUnattendedMode: "full-access",
    });
    expect(resolved).toBe("auto");
  });
});

// Update-7 W3 (e69ed191's gate dry run): a Codex lead's create_agent for a Claude worker was refused ("cannot inherit
// mode 'auto-review' from caller"). For Claude and Codex a new session that names no mode takes ITS OWN provider's
// default, decided downstream (a host plugin's default, else the provider's persisted default) -- never the caller's.
describe("resolveOwnDefaultCreateConfig (Claude, Codex)", () => {
  const claudeModes = [
    { id: "default", label: "default" },
    { id: "acceptEdits", label: "acceptEdits" },
    { id: "plan", label: "plan" },
    { id: "auto", label: "auto" },
    { id: "bypassPermissions", label: "bypassPermissions", isUnattended: true },
  ];
  const codexModes = [
    { id: "auto", label: "auto" },
    { id: "auto-review", label: "auto-review" },
    { id: "full-access", label: "full-access", isUnattended: true },
  ];
  const parent = (provider: string, modeId: string | null, isUnattended = false) => ({
    provider,
    modeId,
    isUnattended,
  });
  const base = { featureValues: undefined, requestedMode: undefined };

  it("Codex lead -> Claude worker: no refusal, no bypass; the worker takes Claude's own default", () => {
    const out = resolveOwnDefaultCreateConfig({
      ...base,
      provider: "claude",
      parent: parent("codex", "full-access", true),
      unattended: true, // folded in from the full-access parent by the snapshot manager
      availableModes: claudeModes,
    });
    expect(out.modeId).toBeUndefined();
  });

  it("an automatic Claude lead -> Codex worker: the worker takes Codex's own default", () => {
    const out = resolveOwnDefaultCreateConfig({
      ...base,
      provider: "codex",
      parent: parent("claude", "auto"),
      unattended: false,
      availableModes: codexModes,
    });
    expect(out.modeId).toBeUndefined();
  });

  // R1 P-8: the restriction class is inherited, not dropped. A restricted caller's child stays restricted; only an
  // automatic caller's child takes its own provider's default.
  it("a restricted caller's same-provider child keeps the caller's mode", () => {
    for (const [provider, modeId, modes] of [
      ["claude", "plan", claudeModes],
      ["claude", "default", claudeModes],
      ["codex", "auto-review", codexModes],
      ["codex", "auto", codexModes],
    ] as const) {
      const out = resolveOwnDefaultCreateConfig({
        ...base,
        provider,
        parent: parent(provider, modeId),
        unattended: false,
        availableModes: [...modes],
      });
      expect(out.modeId, `${provider} ${modeId}`).toBe(modeId);
    }
  });

  it("a restricted caller's cross-provider child gets the target's restricted mode, never bypass", () => {
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        provider: "codex",
        parent: parent("claude", "plan"),
        unattended: false,
        availableModes: codexModes,
      }).modeId,
    ).toBe("auto-review");
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        provider: "claude",
        parent: parent("codex", "auto-review"),
        unattended: false,
        availableModes: claudeModes,
      }).modeId,
    ).toBe("default");
    // Codex without auto-review offered: its plain sandboxed mode.
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        provider: "codex",
        parent: parent("claude", "default"),
        unattended: false,
        availableModes: codexModes.filter((m) => m.id !== "auto-review"),
      }).modeId,
    ).toBe("auto");
  });

  it("a caller whose mode is unknown counts as restricted", () => {
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        provider: "codex",
        parent: { provider: "opencode", modeId: null, isUnattended: false },
        unattended: false,
        availableModes: codexModes,
      }).modeId,
    ).toBe("auto-review");
  });

  it("an explicit mode on a child is honoured even under a restricted caller (owner or lead chose it)", () => {
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        requestedMode: "full-access",
        provider: "codex",
        parent: parent("claude", "plan"),
        unattended: false,
        availableModes: codexModes,
      }).modeId,
    ).toBe("full-access");
  });

  it("classifies modes for children: automatic, restricted or unknown", () => {
    expect(childModeClass("claude", "auto")).toBe("automatic");
    expect(childModeClass("codex", "full-access")).toBe("automatic");
    expect(childModeClass("claude", "bypassPermissions")).toBe("automatic");
    expect(childModeClass("claude", "plan")).toBe("restricted");
    expect(childModeClass("codex", "auto-review")).toBe("restricted");
    expect(childModeClass("codex", null)).toBe("unknown");
    expect(childModeClass("opencode", "build")).toBe("unknown");
  });

  it("an explicit mode wins and is validated; an explicit unattended create keeps the target's unattended mode", () => {
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        requestedMode: "auto-review",
        provider: "codex",
        parent: parent("claude", "auto"),
        unattended: false,
        availableModes: codexModes,
      }).modeId,
    ).toBe("auto-review");
    expect(() =>
      resolveOwnDefaultCreateConfig({
        ...base,
        requestedMode: "turbo",
        provider: "codex",
        parent: null,
        unattended: false,
        availableModes: codexModes,
      }),
    ).toThrow(/Invalid mode 'turbo'/);
    expect(
      resolveOwnDefaultCreateConfig({
        ...base,
        provider: "codex",
        parent: null,
        unattended: true,
        availableModes: codexModes,
      }).modeId,
    ).toBe("full-access");
  });

  it("is what the Claude and Codex clients use, and Codex persists its own default on create", async () => {
    const { ClaudeAgentClient } = await import("./providers/claude/agent.js");
    const { CodexAppServerAgentClient } = await import("./providers/codex-app-server-agent.js");
    const { createTestLogger } = await import("../../test-utils/test-logger.js");
    const claude = new ClaudeAgentClient({ logger: createTestLogger() } as never);
    const codex = new CodexAppServerAgentClient(createTestLogger());
    expect(claude.resolveCreateConfig).toBe(resolveOwnDefaultCreateConfig);
    expect(codex.resolveCreateConfig).toBe(resolveOwnDefaultCreateConfig);
    expect(codex.persistsDefaultModeOnCreate).toBe(true);
    expect(claude.persistsDefaultModeOnCreate).toBe(true);
  });
});

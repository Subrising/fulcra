import { describe, expect, it } from "vitest";
import type { Automation } from "@getpaseo/protocol/messages";
import { openAutomationForm, toAutomationInput } from "./automation-form-model";

describe("automation form model", () => {
  it("builds a pull request → start session automation once everything required is set", () => {
    const form = openAutomationForm({});
    expect(form.getState().canSubmit).toBe(false);
    form.setName("Review new pull requests");
    form.setPullRequestProject("p1", "fulcra-app");
    form.setProject("p1", "fulcra-app");
    form.setTemplate({ kind: "provider", provider: "claude" }, "Claude");
    expect(form.getState().canSubmit).toBe(false);
    form.setPrompt("Review {{event}}");
    expect(toAutomationInput(form.getState())).toEqual({
      name: "Review new pull requests",
      enabled: true,
      trigger: { kind: "pull_request", projectId: "p1", events: ["opened"] },
      action: {
        kind: "start_session",
        projectId: "p1",
        provider: "claude",
        prompt: "Review {{event}}",
      },
    });
  });

  it("only posts a note to GitHub for a pull request trigger, and never by default", () => {
    const form = openAutomationForm({});
    form.setName("Note");
    form.setActionKind("note");
    form.setNoteText("Pull request changed: {{event}}");
    form.setPullRequestProject("p1", "fulcra-app");
    expect(toAutomationInput(form.getState())?.action).toEqual({
      kind: "note",
      text: "Pull request changed: {{event}}",
      postToGithub: false,
    });
    form.setPostToGithub(true);
    expect(toAutomationInput(form.getState())?.action).toMatchObject({ postToGithub: true });
    form.setTriggerKind("session");
    expect(form.getState().canPostToGithub).toBe(false);
    expect(toAutomationInput(form.getState())?.action).toMatchObject({ postToGithub: false });
  });

  it("needs at least one pull request event", () => {
    const form = openAutomationForm({});
    form.setName("x");
    form.setActionKind("note");
    form.setNoteText("y");
    form.setPullRequestProject("p1", "fulcra-app");
    form.togglePullRequestEvent("opened");
    expect(form.getState().canSubmit).toBe(false);
    form.togglePullRequestEvent("updated");
    expect(form.getState().canSubmit).toBe(true);
  });

  it("seeds edit mode from the record, including displays", () => {
    const automation: Automation = {
      id: "a1",
      name: "Follow up",
      enabled: false,
      trigger: { kind: "session", event: "usage_limit", projectId: "p1" },
      action: {
        kind: "message_session",
        agentId: "00000000-0000-4000-8000-000000000001",
        prompt: "Carry on",
      },
      scheduleId: "s1",
      createdAt: "",
      updatedAt: "",
      runs: [],
    };
    const state = openAutomationForm({
      automation,
      names: {
        project: () => "fulcra-app",
        session: () => "Fix the build",
        providerDefaults: (p) => `${p} (defaults)`,
      },
    }).getState();
    expect(state).toMatchObject({
      name: "Follow up",
      enabled: false,
      triggerKind: "session",
      sessionEvent: "usage_limit",
      sessionProjectId: "p1",
      actionKind: "message_session",
      prompt: "Carry on",
      displays: { sessionProject: "fulcra-app", session: "Fix the build" },
      canSubmit: true,
    });
  });

  it("shows a provider template by its readable name when editing", () => {
    const automation: Automation = {
      id: "a2",
      name: "Review",
      enabled: true,
      trigger: { kind: "pull_request", projectId: "p1", events: ["opened"] },
      action: { kind: "start_session", projectId: "p1", provider: "claude", prompt: "Review" },
      scheduleId: "s2",
      createdAt: "",
      updatedAt: "",
      runs: [],
    };
    const state = openAutomationForm({
      automation,
      names: { providerDefaults: () => "Claude Code (default settings)" },
    }).getState();
    expect(state.displays.template).toBe("Claude Code (default settings)");
    expect(state.template).toEqual({ kind: "provider", provider: "claude" });
  });

  it("never lets a session run without asking unless the person turns it on", () => {
    const form = openAutomationForm({});
    form.setName("Review");
    form.setPullRequestProject("p1", "fulcra-app");
    form.setProject("p1", "fulcra-app");
    form.setTemplate({ kind: "provider", provider: "claude" }, "Claude");
    form.setPrompt("Review {{event}}");
    expect(form.getState().allowUnattended).toBe(false);
    expect(toAutomationInput(form.getState())?.action).not.toHaveProperty("allowUnattended");
    form.setAllowUnattended(true);
    expect(toAutomationInput(form.getState())?.action).toMatchObject({ allowUnattended: true });
  });
});

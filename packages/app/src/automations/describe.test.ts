import { describe, expect, it } from "vitest";
import type { Automation } from "@getpaseo/protocol/messages";
import { describeAction, describeCadence, describeRunSource, describeTrigger } from "./describe";

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;
const names = {
  project: (id: string) => (id === "p1" ? "fulcra-app" : undefined),
  session: () => "Fix the build",
  template: () => undefined,
};

const automation: Automation = {
  id: "a",
  name: "Review",
  enabled: true,
  trigger: { kind: "pull_request", projectId: "p1", events: ["opened", "updated"] },
  action: { kind: "start_session", projectId: "p1", provider: "claude", prompt: "Review" },
  scheduleId: "s",
  createdAt: "",
  updatedAt: "",
  runs: [],
};

describe("automation sentences", () => {
  it("names the trigger, the project and the template", () => {
    expect(describeTrigger(t, automation.trigger, names)).toBe(
      'automations.when.pullRequest.both {"project":"fulcra-app"}',
    );
    expect(describeAction(t, automation.action, names)).toBe(
      'automations.do.startSession {"template":"Claude Code","project":"fulcra-app"}',
    );
  });

  it("reads cadences in whole days, hours or minutes", () => {
    expect(describeCadence(t, { type: "every", everyMs: 2 * 3_600_000 })).toBe(
      'automations.cadence.hours {"count":2}',
    );
    expect(describeCadence(t, { type: "every", everyMs: 86_400_000 })).toBe(
      'automations.cadence.days {"count":1}',
    );
  });

  it("says what started a run", () => {
    const run = { id: "r", at: "", trigger: "", status: "ok" as const };
    expect(describeRunSource(t, { ...run, pullRequest: 7 }, automation)).toBe(
      'automations.run.pullRequest {"number":7}',
    );
    expect(describeRunSource(t, { ...run, manual: true }, automation)).toBe(
      "automations.run.manual",
    );
  });
});

import { describe, expect, test } from "vitest";
import { CodexAsyncQuestions } from "./async-questions.js";

const item = {
  type: "agentMessage",
  id: "item-1",
  delivery: "async",
  questions: [{ title: "Is the PC install done?", options: ["Yes", "No"] }],
};

describe("CodexAsyncQuestions", () => {
  // FU-373: a dismissed worker question must tell the agent why, or the agent waits again.
  test("a dismissal with an agent notice gives the agent that notice", () => {
    const questions = new CodexAsyncQuestions(undefined);
    const request = questions.receive(item)!;

    const prepared = questions.prepareResponse(request.id, {
      behavior: "deny",
      message: "Dismissed",
      agentNotice: "No person watches this chat.",
    });

    expect(prepared.prompt).toBe("No person watches this chat.");
    prepared.complete();
    expect(questions.pending()).toEqual([]);
  });

  test("a person's dismissal sends the agent nothing", () => {
    const questions = new CodexAsyncQuestions(undefined);
    const request = questions.receive(item)!;

    expect(
      questions.prepareResponse(request.id, { behavior: "deny", message: "Dismissed by user" })
        .prompt,
    ).toBeUndefined();
  });
});

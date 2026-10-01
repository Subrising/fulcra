import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createToollessGitDraftGeneration } from "./git-ai-draft-generation.js";

const request = {
  cwd: "/selected",
  prompt: "untrusted diff",
  schema: z.object({ advice: z.string() }).strict(),
  schemaName: "Draft",
  agentTitle: "Draft",
};
function stream(messages: unknown[], close = vi.fn()) {
  return Object.assign(
    (async function* () {
      for (const message of messages) yield message;
    })(),
    { close },
  );
}
function heldStream(entered: () => void, held: Promise<void>, close: () => void) {
  return Object.assign(
    (async function* () {
      entered();
      await held;
      yield { type: "result", subtype: "success", is_error: false, result: '{"advice":"stale"}' };
    })(),
    { close },
  );
}
describe("tool-less deliberate Git AI generation", () => {
  test("passes actual SDK enforcement options and attempts once without fallback", async () => {
    const close = vi.fn();
    const query = vi.fn(
      (
        input: Parameters<
          NonNullable<Parameters<typeof createToollessGitDraftGeneration>[0]["query"]>
        >[0],
      ) => {
        expect(input.options?.tools).toEqual([]);
        expect(input.options?.mcpServers).toEqual({});
        expect(input.options?.strictMcpConfig).toBe(true);
        expect(input.options?.settingSources).toEqual([]);
        expect(input.options?.agents).toEqual({});
        expect(input.options?.plugins).toEqual([]);
        expect(input.options?.persistSession).toBe(false);
        return stream(
          [
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result: '{"advice":"Review manually"}',
            },
          ],
          close,
        );
      },
    );
    const driver = createToollessGitDraftGeneration({
      query,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await expect(driver.generate(request)).resolves.toEqual({ advice: "Review manually" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  test("malformed structured response is refused after one attempt", async () => {
    const query = vi.fn(() =>
      stream([{ type: "result", subtype: "success", is_error: false, result: "not JSON" }]),
    );
    const driver = createToollessGitDraftGeneration({
      query,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await expect(driver.generate(request)).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
  });
  test("held native result after caller revocation cannot publish a draft", async () => {
    let resume = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const abort = new AbortController();
    const close = vi.fn();
    const driver = createToollessGitDraftGeneration({
      signal: abort.signal,
      assertCurrent: () => {},
      query: () => heldStream(entered, held, close),
    });
    const pending = driver.generate(request);
    const rejected = expect(pending).rejects.toThrow();
    await started;
    abort.abort();
    resume();
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
  });
  test("an unexpected tool call is refused even with a later success", async () => {
    const query = vi.fn(() =>
      stream([
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: '{"advice":"false success"}',
        },
      ]),
    );
    const driver = createToollessGitDraftGeneration({
      query,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await expect(driver.generate(request)).rejects.toThrow("attempted a tool");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

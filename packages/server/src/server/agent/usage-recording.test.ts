import { expect, test } from "vitest";
import { recordedClaudeUsage, recordedCodexUsage } from "./usage-recording.js";
test("Codex distinguishes cached subset and never invents total scope or creation", () => {
  const usage = recordedCodexUsage(
    {
      last: {
        inputTokens: 100,
        cachedInputTokens: 30,
        outputTokens: 20,
        reasoningOutputTokens: 12,
      },
      total: {
        inputTokens: 200,
        cachedInputTokens: 40,
        outputTokens: 50,
        reasoningOutputTokens: 30,
      },
    },
    "thread-1",
  );
  expect(usage).toMatchObject({
    provider: "codex",
    runtimeSessionId: "thread-1",
    latest: {
      scope: "unknown",
      tokens: { inputNew: 70, cacheRead: 30, output: 20, reasoningOutput: 12 },
    },
    total: {
      scope: "unknown",
      tokens: { inputNew: 160, cacheRead: 40, output: 50, reasoningOutput: 30 },
    },
  });
  expect(usage?.latest?.tokens.cacheWritten).toBeUndefined();
  expect(usage?.estimate).toBeUndefined();
});
test.each([
  { inputTokens: 10, cachedInputTokens: 11 },
  { inputTokens: -1, cachedInputTokens: 1 },
  { inputTokens: 10.5, cachedInputTokens: 1 },
  { inputTokens: 10 },
  { inputTokens: NaN, cachedInputTokens: 1 },
])("invalid/incomplete input relationship never invents input-new", (last) => {
  const usage = recordedCodexUsage({
    last: { ...last, outputTokens: 5, reasoningOutputTokens: 8 },
  });
  expect(usage?.latest?.tokens).toEqual({ output: 5 });
});
test("Claude snapshots preserve creation, latest unknown, query pipeline totals and qualified estimate", () => {
  const base = {
    session_id: "s1",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
    },
    modelUsage: {
      a: {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        outputTokens: 400,
      },
      b: { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4 },
    },
    total_cost_usd: 0.5,
  };
  const first = recordedClaudeUsage(base);
  const second = recordedClaudeUsage({ ...base, total_cost_usd: 0.6 });
  expect(first).toMatchObject({
    latest: {
      scope: "unknown",
      tokens: { inputNew: 10, cacheRead: 20, cacheWritten: 30, output: 40 },
    },
    total: {
      scope: "provider-query",
      tokens: { inputNew: 101, cacheRead: 202, cacheWritten: 303, output: 404 },
    },
    estimate: { scope: "provider-query", kind: "provider-api-estimate", amountUsd: 0.5 },
  });
  expect(second?.total).toEqual(first?.total);
  expect(second?.estimate?.amountUsd).toBe(0.6);
});
test("missing/invalid model buckets stay missing; zero is an observation", () => {
  const result = recordedClaudeUsage({
    usage: { cache_creation_input_tokens: 0 },
    modelUsage: { a: { inputTokens: 10, outputTokens: 20 }, b: { outputTokens: NaN } },
    total_cost_usd: -1,
  });
  expect(result?.latest?.tokens).toEqual({ cacheWritten: 0 });
  expect(result?.total).toBeUndefined();
  expect(result?.estimate).toBeUndefined();
  expect(recordedClaudeUsage({ usage: {} })).toBeUndefined();
  expect(recordedCodexUsage({ last: {} })).toBeUndefined();
});

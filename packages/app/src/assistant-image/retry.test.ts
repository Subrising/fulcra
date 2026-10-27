import { describe, expect, it } from "vitest";
import { getAssistantImageLoadRetryDelayMs, runAssistantImageOperationWithRetry } from "./retry";

describe("assistant image retry", () => {
  it("recovers from transient failures while the image remains mounted", async () => {
    const waits: number[] = [];
    let attempts = 0;

    const result = await runAssistantImageOperationWithRetry({
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("transient");
        }
        return "loaded";
      },
      delaysMs: [10, 20, 30],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect({ attempts, waits, result }).toEqual({
      attempts: 3,
      waits: [10, 20],
      result: "loaded",
    });
  });

  it("stops retrying after the image is released", async () => {
    let stopped = false;
    let attempts = 0;

    await expect(
      runAssistantImageOperationWithRetry({
        operation: async () => {
          attempts += 1;
          throw new Error("transient");
        },
        delaysMs: [10, 20],
        shouldStop: () => stopped,
        wait: async () => {
          stopped = true;
        },
      }),
    ).rejects.toThrow("transient");
    expect(attempts).toBe(1);
  });
});

describe("assistant image load retry delay", () => {
  it("returns a delay for each allowed retry and null after the last", () => {
    expect([0, 1, 2, 3].map(getAssistantImageLoadRetryDelayMs)).toEqual([100, 400, 1_200, null]);
  });
});

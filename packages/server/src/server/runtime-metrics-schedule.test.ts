import { describe, expect, it } from "vitest";
import {
  isRuntimeMetricsWindowBusy,
  nextRuntimeMetricsDelayMs,
} from "./runtime-metrics-schedule.js";

describe("runtime metrics schedule", () => {
  it("logs every 60 s when idle and every 30 s when busy", () => {
    expect(nextRuntimeMetricsDelayMs(false)).toBe(60_000);
    expect(nextRuntimeMetricsDelayMs(true)).toBe(30_000);
  });
  it("is idle with no traffic and no git work", () => {
    expect(isRuntimeMetricsWindowBusy({ counters: { a: 0 }, gitActive: 0, gitPending: 0 })).toBe(
      false,
    );
  });
  it("is busy with traffic or git work", () => {
    expect(isRuntimeMetricsWindowBusy({ counters: { a: 3 }, gitActive: 0, gitPending: 0 })).toBe(
      true,
    );
    expect(isRuntimeMetricsWindowBusy({ counters: {}, gitActive: 0, gitPending: 2 })).toBe(true);
  });
});

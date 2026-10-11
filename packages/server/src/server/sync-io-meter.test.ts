import { describe, expect, it, vi } from "vitest";
import {
  createSyncIoMeter,
  startSyncIoMeter,
  SYNC_IO_METER_KEY,
  timedSync,
} from "./sync-io-meter.js";

describe("synchronous disk meter (FU-77)", () => {
  it("counts calls and time per site and reports only sites that took time", () => {
    let clock = 0;
    const meter = createSyncIoMeter(() => clock);
    const slow = (ms: number) => () => {
      clock += ms;
      return ms;
    };
    expect(meter.timed("journal.write", slow(40))).toBe(40);
    meter.timed("journal.write", slow(10));
    meter.timed("accounts.read", slow(0.2));
    expect(meter.drain()).toEqual([{ site: "journal.write", calls: 2, totalMs: 50, maxMs: 40 }]);
    expect(meter.drain()).toEqual([]);
  });

  it("still counts a call that throws, and passes the error on", () => {
    let clock = 0;
    const meter = createSyncIoMeter(() => clock);
    const failing = () => {
      clock += 5;
      throw new Error("disk");
    };
    expect(() => meter.timed("x", failing)).toThrow("disk");
    expect(meter.drain()[0]).toMatchObject({ site: "x", calls: 1, totalMs: 5 });
  });

  it("logs once a minute, and only when a site took time; stopping removes the meter", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const target: Record<symbol, unknown> = {};
      const log = vi.fn();
      const stop = startSyncIoMeter(log, 60_000, target);
      const meter = target[SYNC_IO_METER_KEY] as ReturnType<typeof createSyncIoMeter>;
      vi.advanceTimersByTime(60_000);
      expect(log).not.toHaveBeenCalled();
      meter.timed("slow", () => {
        const end = performance.now() + 3;
        while (performance.now() < end);
      });
      vi.advanceTimersByTime(60_000);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0][0]).toMatchObject({ site: "slow", calls: 1 });
      stop();
      expect(target[SYNC_IO_METER_KEY]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("timedSync runs the call with or without a meter, once", () => {
    const call = vi.fn(() => undefined);
    timedSync("a", call);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

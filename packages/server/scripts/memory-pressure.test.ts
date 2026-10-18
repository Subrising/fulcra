import { expect, test } from "vitest";
import {
  parseDarwinPressureLevel,
  parseLinuxPressure,
  readHostMemoryPressure,
} from "./memory-pressure.js";

test("macOS pressure values map to levels", () => {
  expect(parseDarwinPressureLevel("1\n")).toBe("normal");
  expect(parseDarwinPressureLevel("2\n")).toBe("warn");
  expect(parseDarwinPressureLevel("4\n")).toBe("critical");
  expect(parseDarwinPressureLevel("")).toBe("unknown");
  expect(parseDarwinPressureLevel("x")).toBe("unknown");
});

test("Linux pressure files map to levels", () => {
  const file = (some: string, full: string) =>
    `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`;
  expect(parseLinuxPressure(file("0.00", "0.00"))).toBe("normal");
  expect(parseLinuxPressure(file("30.00", "1.00"))).toBe("warn");
  expect(parseLinuxPressure(file("50.00", "12.00"))).toBe("critical");
  expect(parseLinuxPressure("garbage")).toBe("unknown");
});

test("the host reader returns a level and never throws", async () => {
  expect(["normal", "warn", "critical", "unknown"]).toContain(await readHostMemoryPressure());
});

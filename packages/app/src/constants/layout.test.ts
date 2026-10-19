import { describe, expect, it } from "vitest";
import { isCompactFormFactor } from "./layout";

describe("isCompactFormFactor", () => {
  it("is compact for phone portrait widths", () => {
    expect(isCompactFormFactor("xs", 812, true)).toBe(true);
    expect(isCompactFormFactor("sm", 900, false)).toBe(true);
  });

  it("is compact for a phone held sideways", () => {
    expect(isCompactFormFactor("md", 375, true)).toBe(true);
    expect(isCompactFormFactor("md", 430, true)).toBe(true);
  });

  it("keeps the desktop shell for a short window with a mouse", () => {
    expect(isCompactFormFactor("md", 260, false)).toBe(false);
  });

  it("keeps the desktop shell for tablets and desktops", () => {
    expect(isCompactFormFactor("md", 1024, true)).toBe(false);
    expect(isCompactFormFactor("md", 500, true)).toBe(false);
    expect(isCompactFormFactor("lg", 375, true)).toBe(false);
    expect(isCompactFormFactor("xl", 400, true)).toBe(false);
  });
});

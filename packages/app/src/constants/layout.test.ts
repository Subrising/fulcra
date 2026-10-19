import { describe, expect, it } from "vitest";
import { isCompactFormFactor } from "./layout";

describe("isCompactFormFactor", () => {
  it("is compact for phone portrait widths", () => {
    expect(isCompactFormFactor("xs", 812)).toBe(true);
    expect(isCompactFormFactor("sm", 900)).toBe(true);
  });

  it("is compact for a phone held sideways", () => {
    expect(isCompactFormFactor("md", 375)).toBe(true);
    expect(isCompactFormFactor("md", 430)).toBe(true);
  });

  it("keeps the desktop shell for tablets and desktops", () => {
    expect(isCompactFormFactor("md", 1024)).toBe(false);
    expect(isCompactFormFactor("md", 500)).toBe(false);
    expect(isCompactFormFactor("lg", 375)).toBe(false);
    expect(isCompactFormFactor("xl", 400)).toBe(false);
  });
});

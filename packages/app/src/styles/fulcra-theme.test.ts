import { describe, expect, it } from "vitest";
import { REGISTERED_THEMES, THEME_OPTIONS, THEME_TO_UNISTYLES, ICON_STROKE_WIDTH } from "./theme";

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("Fulcra theme seam", () => {
  it("points dark and light (so auto and the default) at the Fulcra themes", () => {
    const dark = THEME_OPTIONS.find((o) => o.name === "dark");
    const light = THEME_OPTIONS.find((o) => o.name === "light");
    expect(dark && "unistylesName" in dark && dark.unistylesName).toBe("dark");
    expect(light && "unistylesName" in light && light.unistylesName).toBe("light");
    expect(THEME_TO_UNISTYLES.dark).toBe("dark");
    expect(REGISTERED_THEMES.dark.colors.accent).toBe("#ff8a5b");
    expect(REGISTERED_THEMES.light.colors.accent).toBe("#a83c1a");
    expect(REGISTERED_THEMES.dark.colors.surface0).toBe("#121112");
    expect(REGISTERED_THEMES.light.colors.surface0).toBe("#fbf7ef");
  });

  it("keeps Paseo green only in pureBlack and the plugin fallbacks (a user or plugin choice)", () => {
    const greens = Object.entries(REGISTERED_THEMES)
      .filter(([, t]) => JSON.stringify(t.colors).toLowerCase().includes("#20744a"))
      .map(([name]) => name);
    expect(greens).toEqual(["darkPureBlack", "pluginLight", "pluginDark"]);
  });

  it("keeps coral off success, and success green", () => {
    for (const name of ["dark", "light"] as const) {
      const c = REGISTERED_THEMES[name].colors;
      expect(c.success).not.toBe(c.accent);
      expect(c.primary).toBe(c.accent);
    }
  });

  it("gives Fulcra themes a burgundy user bubble and other themes the neutral one", () => {
    expect(REGISTERED_THEMES.dark.colors.userBubble).toBe("#431521");
    expect(REGISTERED_THEMES.light.colors.userBubble).toBe("#5e1623");
    expect(REGISTERED_THEMES.darkZinc.colors.userBubble).toBe(
      REGISTERED_THEMES.darkZinc.colors.surface3,
    );
    expect(
      ratio(REGISTERED_THEMES.dark.colors.userBubbleForeground, "#431521"),
    ).toBeGreaterThanOrEqual(7);
    expect(
      ratio(REGISTERED_THEMES.light.colors.userBubbleForeground, "#5e1623"),
    ).toBeGreaterThanOrEqual(7);
  });

  it("keeps the 3px selected bar and active label at 3:1 or more in both modes", () => {
    for (const name of ["dark", "light"] as const) {
      const c = REGISTERED_THEMES[name].colors;
      expect(ratio(c.accent, c.surfaceSidebar), `${name} bar on sidebar`).toBeGreaterThanOrEqual(3);
      expect(
        ratio(c.accent, c.surfaceSidebarSelected),
        `${name} bar on selected`,
      ).toBeGreaterThanOrEqual(3);
      expect(c.surfaceSidebarSelected).toBe(c.surface3);
      expect(c.surfaceSidebarHover).toBe(c.surface3);
    }
  });

  it("uses the 1.75 icon stroke", () => {
    expect(ICON_STROKE_WIDTH).toBe(1.75);
  });

  it("passes contrast on the text and control pairs", () => {
    const d = REGISTERED_THEMES.dark.colors;
    const l = REGISTERED_THEMES.light.colors;
    const text: [string, string][] = [
      [d.foreground, d.surface0],
      [d.foregroundMuted, d.surface0],
      [d.foregroundExtraMuted, d.surface2],
      [d.accentForeground, d.accent],
      [d.accentBright, d.surface0],
      [d.destructive, d.surface0],
      [l.foreground, l.surface0],
      [l.foregroundMuted, l.surface2],
      [l.foregroundExtraMuted, l.surface2],
      [l.accentForeground, l.accent],
      [l.accent, l.surface2],
      [l.destructive, l.surface2],
    ];
    for (const [fg, bg] of text)
      expect(ratio(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(ratio(d.ring, d.surface0)).toBeGreaterThanOrEqual(3);
    expect(ratio(l.ring, l.surface0)).toBeGreaterThanOrEqual(3);
  });
});

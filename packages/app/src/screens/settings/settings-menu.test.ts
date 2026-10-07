import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { HOST_SECTION_SLUGS, SETTINGS_SECTION_SLUGS } from "@/utils/host-routes";
import {
  ADVANCED_GROUP_ORDER,
  ADVANCED_SECTIONS,
  EVERYDAY_SECTIONS,
  HOST_SECTION_DESCRIPTION_KEYS,
  HOST_SECTION_LABEL_KEYS,
  PLUGIN_SCREEN_DESCRIPTION_KEYS,
  SECTION_DESCRIPTION_KEYS,
  SECTION_LABEL_KEYS,
  isAdvancedSection,
  menuSectionFor,
  shouldOpenAdvanced,
} from "./settings-menu";

function lookup(key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, en);
}

describe("settings menu", () => {
  it("gives every page a label and a one-line description", () => {
    const keys = [
      ...SETTINGS_SECTION_SLUGS.flatMap((slug) => [
        SECTION_LABEL_KEYS[slug],
        SECTION_DESCRIPTION_KEYS[slug],
      ]),
      ...HOST_SECTION_SLUGS.flatMap((slug) => [
        HOST_SECTION_LABEL_KEYS[slug],
        HOST_SECTION_DESCRIPTION_KEYS[slug],
      ]),
      ...Object.values(PLUGIN_SCREEN_DESCRIPTION_KEYS),
    ];
    for (const key of keys) {
      const value = lookup(key);
      expect(typeof value, key).toBe("string");
      expect((value as string).includes("\n"), key).toBe(false);
    }
  });

  it("keeps the first page short and puts every other page under Advanced exactly once", () => {
    expect(EVERYDAY_SECTIONS).toEqual(["general", "notifications"]);
    const advanced = ADVANCED_GROUP_ORDER.flatMap((group) => ADVANCED_SECTIONS[group]);
    expect(new Set(advanced).size).toBe(advanced.length);
    const listed = new Set([...EVERYDAY_SECTIONS, ...advanced]);
    const unlisted = SETTINGS_SECTION_SLUGS.filter((slug) => !listed.has(menuSectionFor(slug)));
    expect(unlisted).toEqual([]);
  });

  it("opens Advanced only when the current page lives inside it", () => {
    expect(shouldOpenAdvanced({ kind: "root" })).toBe(false);
    expect(shouldOpenAdvanced({ kind: "section", section: "appearance" })).toBe(false);
    expect(shouldOpenAdvanced({ kind: "section", section: "licenses" })).toBe(true);
    expect(shouldOpenAdvanced({ kind: "host", section: "usage" })).toBe(true);
    expect(shouldOpenAdvanced({ kind: "plugin", screenId: "accounts" })).toBe(false);
    expect(shouldOpenAdvanced({ kind: "plugin", screenId: "cleanup" })).toBe(true);
    expect(isAdvancedSection("diagnostics")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";

const K = "panels.architectureMap.review";

describe("review copy for test counts", () => {
  it("uses the singular for one test and the plural otherwise", () => {
    const t = i18n.getFixedT("en");
    expect(t(`${K}.plain.changedCodeTested`, { count: 1 })).toBe("Changes code that 1 test reaches");
    expect(t(`${K}.plain.changedCodeTested`, { count: 4 })).toBe("Changes code that 4 tests reach");
    expect(t(`${K}.riskExplain.NORMAL`, { count: 1 })).toBe("Normal risk: code that 1 test reaches.");
    expect(t(`${K}.riskExplain.NORMAL`, { count: 2 })).toBe("Normal risk: code that 2 tests reach.");
    expect(t(`${K}.riskExplain.LOW`, { count: 0 })).toBe("Low risk: tests, docs or configuration.");
  });
});

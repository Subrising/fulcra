import { describe, expect, it } from "vitest";
import { explainBudgetOptions } from "./explain-budget-card";

describe("explainBudgetOptions", () => {
  it("offers Off and a few sizes, and keeps a cap set some other way", () => {
    expect(explainBudgetOptions(30).map((o) => o.label)).toEqual(["Off", "10", "30", "60", "100"]);
    expect(explainBudgetOptions(12).map((o) => o.value)).toEqual([
      "0",
      "10",
      "12",
      "30",
      "60",
      "100",
    ]);
  });
});

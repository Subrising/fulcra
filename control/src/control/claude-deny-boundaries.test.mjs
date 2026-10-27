// The cases need the pinned pre-trusted-hook fixture, which is built from a commit of the product history
// (docs/historical-overlay-tests.md). Where it is not built, the file reports one skipped test with the reason.
import test from "node:test";
import { historicalRepairSkip } from "../../tools/test-support.historical-repair.mjs";

const skip = historicalRepairSkip();
if (skip) test("claude deny boundaries on the historical fixture", { skip }, () => {});
else await import("./claude-deny-boundaries.cases.mjs");

#!/usr/bin/env node
// V5 uses the same ASAR-aware, confined-link audit as packaging. No bypass mode.
import fs from "node:fs";
import { auditPackagedBundle } from "./packaged-audit.mjs";
try {
  const [app, reviews, ...extra] = process.argv.slice(2);
  if (!app || !reviews || extra.length)
    throw Error("Usage: v5-exact-audit.mjs <Fulcra.app> <exact-reviewed-matches.json>");
  const result = auditPackagedBundle(app, JSON.parse(fs.readFileSync(reviews, "utf8")));
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
} catch (error) {
  console.log(
    JSON.stringify({
      passed: false,
      files: 0,
      findings: [],
      unexempted: [],
      errors: [{ error: error.message }],
    }),
  );
  process.exitCode = 1;
}

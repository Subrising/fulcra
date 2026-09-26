import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { upstreamLicense, upstreamNotice } from "./notices.gen";

const repoRoot = join(__dirname, "../../../..");

// The Licenses screen must show the notices the Apache License 2.0 requires, word for word.
// When NOTICE or LICENSE changes, regenerate with: node packages/app/src/licenses/build-notices.mjs
describe("licence notices shown in the app", () => {
  it("match the repository NOTICE", () => {
    expect(upstreamNotice).toBe(readFileSync(join(repoRoot, "NOTICE"), "utf8"));
  });

  it("match the repository LICENSE", () => {
    expect(upstreamLicense).toBe(readFileSync(join(repoRoot, "LICENSE"), "utf8"));
  });

  it("keep the upstream attribution", () => {
    expect(upstreamNotice).toContain("Fulcra is based on Paseo (Apache-2.0) by Mohamed Boudra.");
    expect(upstreamNotice).toContain("Licensed under the Apache License, Version 2.0");
    expect(upstreamLicense).toContain("Copyright (c) 2025-present Mohamed Boudra");
  });
});

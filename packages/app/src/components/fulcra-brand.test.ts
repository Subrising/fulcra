import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// BrandGlow may only sit behind welcome, splash and open-project (FU-401 FINAL-BRIEF section 4).
// Never behind chat, diff or terminal text.
const ALLOWED_GLOW_IMPORTERS = [
  "components/welcome-screen.tsx",
  "screens/open-project-screen.tsx",
  "screens/startup-splash-screen.tsx",
];

describe("BrandGlow importers", () => {
  it("lists only the allowed screens", () => {
    const srcRoot = path.resolve(__dirname, "..");
    const out = execFileSync(
      "grep",
      ["-rlE", "\\bBrandGlow\\b", srcRoot, "--include=*.tsx", "--include=*.ts"],
      {
        encoding: "utf8",
      },
    );
    const files = out
      .split("\n")
      .filter(Boolean)
      .map((f) => path.relative(srcRoot, f))
      .filter((f) => !f.startsWith("components/fulcra-brand"))
      .sort();
    expect(files).toEqual(ALLOWED_GLOW_IMPORTERS);
  });
});

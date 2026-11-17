import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests must not read FULCRA_* settings from the shell that starts them.
    globalSetup: [path.resolve(__dirname, "../../scripts/vitest-global-setup.mjs")],
  },
});

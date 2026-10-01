import { defineConfig, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import base from "./vitest.config";

// Capture the real component with fixture RPCs, without scanning the app router.
const config = mergeConfig(
  base,
  defineConfig({
    esbuild: { jsx: "automatic" },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react/jsx-dev-runtime",
        "react",
        "react-dom/client",
        "react-native",
        "@tanstack/react-query",
        "qrcode",
        "base64-js",
        "tweetnacl",
        "i18next",
        "react-i18next",
        "@getpaseo/highlight",
      ],
    },
  }),
);
config.test = {
  ...config.test,
  projects: [
    {
      extends: true,
      test: {
        name: "browser",
        include: ["src/desktop/components/pair-device-section.browser.test.tsx"],
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({
            contextOptions: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 },
          }),
          instances: [{ browser: "chromium" }],
          screenshotDirectory: ".vitest-screenshots",
        },
      },
    },
  ],
};
export default config;

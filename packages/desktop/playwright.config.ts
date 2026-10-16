import { defineConfig, devices } from "@playwright/test";

const baseURL =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;

function videoMode(): "off" | "on" | "on-first-retry" | "retain-on-failure" {
  if (process.env.E2E_RECORD_VIDEO === "0") return "off";
  if (process.env.E2E_RECORD_VIDEO === "1") return "on";
  if (process.env.CI) return "on-first-retry";
  return "retain-on-failure";
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/*.spec.ts"],
  globalSetup: "../app/e2e/support/global-setup.ts",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: videoMode(),
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

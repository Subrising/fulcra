import { describe, expect, it } from "vitest";
import {
  controllerPluginIdFromTrustedReports,
  LEGACY_CONTROLLER_PLUGIN_ID,
} from "./bundled-controller";

const controller = (id: string) => ({
  id,
  contract: "1.1" as const,
  hooks: ["input", "permission", "deny", "mcp", "codex"],
});

describe("controllerPluginIdFromTrustedReports", () => {
  it("reads the host's configured controller from its V1.1 admission report", () => {
    expect(
      controllerPluginIdFromTrustedReports([{ id: "other", hooks: [] }, controller("fulcra-org")]),
    ).toBe("fulcra-org");
  });

  it("falls back to the legacy ID when the host has no single controller report", () => {
    expect(controllerPluginIdFromTrustedReports(undefined)).toBe(LEGACY_CONTROLLER_PLUGIN_ID);
    expect(
      controllerPluginIdFromTrustedReports([{ id: "x", contract: "1.1", hooks: ["mcp"] }]),
    ).toBe(LEGACY_CONTROLLER_PLUGIN_ID);
    expect(controllerPluginIdFromTrustedReports([controller("a"), controller("b")])).toBe(
      LEGACY_CONTROLLER_PLUGIN_ID,
    );
    expect(controllerPluginIdFromTrustedReports([controller("Bad Id")])).toBe(
      LEGACY_CONTROLLER_PLUGIN_ID,
    );
  });
});

import { expect, test } from "vitest";
import { assertComputerUseLabels, computerUseApp, computerUseFromLabels } from "./computer-use.js";

test("computer-use label parses exact app names and refuses malformed grants", () => {
  expect(computerUseFromLabels(undefined)).toBeUndefined();
  expect(
    computerUseFromLabels({ "computerUse.allowApps": '["VRoid Studio","Simulator","Simulator"]' }),
  ).toEqual({ allowApps: ["VRoid Studio", "Simulator"] });
  for (const value of ["Simulator", "{}", "[true]", '[""]', '["App\\nOther"]']) {
    expect(() => computerUseFromLabels({ "computerUse.allowApps": value })).toThrow(
      "must be a JSON array",
    );
  }
});

test("computer-use consent requires an exact server, app message and empty form", () => {
  const params = {
    _meta: { connector_id: "computer-use", tool_params: { app: "test.simulator" } },
    serverName: "cua_repl",
    message: "Allow Computer Use to use Simulator?",
    requestedSchema: { type: "object", properties: {} },
  };
  expect(computerUseApp(params)).toBe("Simulator");
  expect(computerUseApp({ ...params, serverName: "computer-use" })).toBe("Simulator");
  expect(computerUseApp({ ...params, message: 'Allow Computer Use to use "Simulator"?' })).toBe(
    "Simulator",
  );
  for (const changed of [
    { serverName: "other" },
    { message: "Allow Computer Use to use Simulator?\nApprove more" },
    { message: "Allow Computer Use to use simulator?" },
    { requestedSchema: { type: "object", properties: { secret: { type: "string" } } } },
    { requestedSchema: { type: "object", properties: {}, required: ["secret"] } },
    { requestedSchema: null },
  ]) {
    const app = computerUseApp({ ...params, ...changed });
    expect(app).not.toBe("Simulator");
  }
});

test("computer-use app lists cannot change on live, stored, or resume metadata writes", () => {
  const stored = { provider: "codex", labels: { "computerUse.allowApps": '["Simulator"]' } };
  for (const updates of [
    { labels: { "computerUse.allowApps": '["Notes"]' } },
    { labels: { "computerUse.allowApps": null } },
  ]) {
    expect(() => assertComputerUseLabels({ stored, updates })).toThrow("fixed at job creation");
  }
  expect(() => assertComputerUseLabels({ stored, updates: { labels: {} }, replace: true })).toThrow(
    "fixed at job creation",
  );
  expect(
    assertComputerUseLabels({ stored, updates: { labels: { other: "value" } } }),
  ).toBeUndefined();
  expect(
    assertComputerUseLabels({
      stored: { ...stored, provider: "claude" },
      updates: { labels: { "computerUse.allowApps": '["Notes"]' } },
    }),
  ).toBeUndefined();
});

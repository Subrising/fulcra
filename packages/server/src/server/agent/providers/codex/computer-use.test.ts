import { expect, test } from "vitest";
import { computerUseApp, computerUseFromLabels } from "./computer-use.js";

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

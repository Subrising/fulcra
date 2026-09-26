import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { ACKNOWLEDGEMENTS } from "./acknowledgements";

describe("acknowledgements", () => {
  it("credits Archify's IR format in one line without claiming shipped Archify code", () => {
    const archify = ACKNOWLEDGEMENTS.find((entry) => entry.id === "archify");
    expect(archify).toMatchObject({ name: "Archify", licence: "MIT", shipsThirdPartyCode: false });
    expect(archify?.line).toMatch(/Archify Architecture IR v1/);
    expect(archify?.line).toMatch(/contains no Archify code/);
    expect(archify?.line).not.toMatch(/\n/);
    expect(archify?.line).not.toMatch(/https?:/);
  });

  it("keeps Archify out of user-visible app strings (credit lives on the Licenses screen only)", () => {
    expect(JSON.stringify(en)).not.toMatch(/archify/i);
  });

  it("uses unique ids", () => {
    const ids = ACKNOWLEDGEMENTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

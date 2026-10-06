import { describe, expect, it } from "vitest";
import {
  architectureMapPath,
  canOpenCodeArchitecture,
  isArchitectureMapFileName,
  isMissingDirectoryError,
  MAX_ARCHITECTURE_MAPS,
  selectArchitectureMaps,
} from "./discovery";
import { ARCHITECTURE_IR_LIMITS } from "./ir-schema";

const file = (name: string, size = 100) => ({ name, kind: "file" as const, size });

describe("architecture map discovery", () => {
  it("builds paths only under .fulcra/architecture", () => {
    expect(architectureMapPath("defproof.ir.json")).toBe(".fulcra/architecture/defproof.ir.json");
  });

  it.each([
    "../secret.ir.json",
    "a/b.ir.json",
    "a\\b.ir.json",
    ".hidden.ir.json",
    "x\u0000.ir.json",
    "..ir.json",
    ".ir.json",
    "map.json",
    "map.ir.json.bak",
    "a..b.ir.json",
    "/abs.ir.json",
  ])("rejects %j", (name) => {
    expect(isArchitectureMapFileName(name)).toBe(false);
    expect(architectureMapPath(name)).toBeNull();
  });

  it("lists sorted .ir.json files and ignores directories", () => {
    const listing = selectArchitectureMaps([
      file("b.ir.json"),
      { name: "dir.ir.json", kind: "directory", size: 0 },
      file("notes.md"),
      file("a.ir.json"),
    ]);
    expect(listing.maps.map((entry) => entry.path)).toEqual([
      ".fulcra/architecture/a.ir.json",
      ".fulcra/architecture/b.ir.json",
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("reports oversized maps instead of offering them", () => {
    const listing = selectArchitectureMaps([
      file("big.ir.json", ARCHITECTURE_IR_LIMITS.maxBytes + 1),
      file("ok.ir.json", ARCHITECTURE_IR_LIMITS.maxBytes),
    ]);
    expect(listing.maps.map((entry) => entry.name)).toEqual(["ok.ir.json"]);
    expect(listing.oversized).toEqual(["big.ir.json"]);
  });

  it("caps the list and says so", () => {
    const entries = Array.from({ length: MAX_ARCHITECTURE_MAPS + 3 }, (_, i) =>
      file(`m${String(i).padStart(2, "0")}.ir.json`),
    );
    const listing = selectArchitectureMaps(entries);
    expect(listing.maps).toHaveLength(MAX_ARCHITECTURE_MAPS);
    expect(listing.truncated).toBe(true);
  });

  it("treats a missing directory as no maps", () => {
    expect(isMissingDirectoryError("ENOENT: no such file or directory")).toBe(true);
    expect(isMissingDirectoryError("Access outside of workspace is not allowed")).toBe(false);
  });
});


it("code entry matches the panel’s saved-IR or literal native capability paths, never a team graph", () => {
  expect(canOpenCodeArchitecture({ hasMaps: false, canGenerate: false, canGraph: false })).toBe(false);
  expect(canOpenCodeArchitecture({ hasMaps: true, canGenerate: false, canGraph: false })).toBe(true);
  expect(canOpenCodeArchitecture({ hasMaps: false, canGenerate: true, canGraph: false })).toBe(true);
  expect(canOpenCodeArchitecture({ hasMaps: false, canGenerate: false, canGraph: true })).toBe(true);
});

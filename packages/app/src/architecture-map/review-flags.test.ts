import { describe, expect, it } from "vitest";
import { beforeYouApprove, reviewFlags, type ReviewDiff } from "./review-flags";

const add = (content: string) => ({ type: "add" as const, content });
const ctx = (content: string) => ({ type: "context" as const, content });
const del = (content: string) => ({ type: "remove" as const, content });
const diff = (lines: ReviewDiff["hunks"][number]["lines"], start = 10): ReviewDiff => ({
  isDeleted: false,
  hunks: [{ oldStart: start, newStart: start, lines }],
});
const code = { kind: "code" as const, status: "modified" as const };

describe("reviewFlags", () => {
  it("flags the exact new lines: a network call without a timeout, credentials and file writes", () => {
    const flags = reviewFlags(
      diff([
        ctx("export async function forecast(city) {"),
        add("  const res = await fetch(`https://api.example/${city}`);"),
        add("  const key = process.env.WEATHER_API_KEY;"),
        add('  await fs.writeFile("cache.json", body);'),
        add("  const ok = await fetch(url, { signal: AbortSignal.timeout(5000) });"),
        add("  // fetch(url) in a comment is not a call"),
      ]),
      code,
    );
    expect(flags.map((f) => [f.kind, f.line])).toEqual([
      ["network-no-timeout", 11],
      ["credentials", 12],
      ["writes-disk", 13],
    ]);
    expect(flags[0]?.text).toBe("const res = await fetch(`https://api.example/${city}`);");
  });

  it("counts lines past removals, and flags removed tests at their old line", () => {
    const flags = reviewFlags(
      diff(
        [del('it("handles an empty city", () => {'), del("});"), add('const password = "x";')],
        40,
      ),
      code,
    );
    expect(flags.map((f) => [f.kind, f.line])).toEqual([
      ["deleted-test", 40],
      ["credentials", 40],
    ]);
  });

  it("flags a large new function once, at its first line, and a deleted test file as a whole", () => {
    const body = Array.from({ length: 70 }, (_, i) => add(`  step${i}();`));
    const flags = reviewFlags(
      diff([add("function printTable(rows) {"), ...body, add("}")], 1),
      code,
    );
    expect(flags).toEqual([{ kind: "large-function", line: 1, text: "72 new lines in one block" }]);
    expect(reviewFlags(null, { kind: "test", status: "deleted" })[0]?.kind).toBe("deleted-test");
  });

  it("adds the automated findings and keeps at most three flags of a kind", () => {
    const lines = Array.from({ length: 5 }, (_, i) => add(`fetch("/a${i}")`));
    const flags = reviewFlags(diff(lines), code, [{ line: 3, message: "Unbounded retry" }]);
    expect(flags.filter((f) => f.kind === "network-no-timeout")).toHaveLength(3);
    expect(flags.find((f) => f.kind === "finding")).toEqual({
      kind: "finding",
      line: 3,
      text: "Unbounded retry",
    });
  });
});

describe("beforeYouApprove", () => {
  const files = [
    { path: "weather.py", kind: "code" as const, status: "modified" as const, partLabel: "CLI" },
    { path: "api/client.py", kind: "code" as const, status: "added" as const, partLabel: "API" },
    {
      path: ".github/workflows/ci.yml",
      kind: "other" as const,
      status: "modified" as const,
      partLabel: "Repo",
    },
  ];
  it("says what was checked, that tests did not change, the build files and the parts touched", () => {
    const flagsByPath = new Map([
      ["weather.py", [{ kind: "credentials" as const, line: 4, text: "x" }]],
    ]);
    expect(beforeYouApprove({ files, flagsByPath })).toEqual([
      { key: "flags", state: "look", text: "1 place to look at in 1 opened file of 3" },
      { key: "tests", state: "look", text: "Code changed but no test file did" },
      {
        key: "build",
        state: "look",
        text: "Also changes build or dependency files: .github/workflows/ci.yml",
      },
      { key: "parts", state: "look", text: "Touches 2 parts of the map: CLI, API" },
    ]);
  });
  it("reads as all clear when every file is opened and clean, tests changed and one part moved", () => {
    const clean = [
      files[0]!,
      {
        path: "tests/test_weather.py",
        kind: "test" as const,
        status: "modified" as const,
        partLabel: "CLI",
      },
    ];
    const flagsByPath = new Map(clean.map((f) => [f.path, []]));
    expect(beforeYouApprove({ files: clean, flagsByPath }).map((c) => c.state)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(beforeYouApprove({ files: clean, flagsByPath: new Map() })[0]).toEqual({
      key: "flags",
      state: "unknown",
      text: "Open a file to check it for places to look",
    });
  });
});

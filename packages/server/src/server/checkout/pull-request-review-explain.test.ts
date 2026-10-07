import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { pickEntryFiles } from "./module-excerpt.js";
import { diffText, handlePullRequestReviewExplain } from "./pull-request-review-explain.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const file: ParsedDiffFile = {
  path: "weather.py",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 3,
      oldCount: 2,
      newStart: 3,
      newCount: 2,
      lines: [
        { type: "context", content: "def show(rows):" },
        { type: "remove", content: "    print(rows)" },
        { type: "add", content: "    print(table(rows))" },
      ],
    },
  ],
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "explain-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup(over: { limit?: number; diff?: ParsedDiffFile | null; fail?: boolean } = {}) {
  const generate = vi.fn(async () => {
    if (over.fail) throw new Error("provider down");
    return { text: "Prints the rows as a table instead of a raw list." };
  });
  const deps = {
    listWorkspaceCwds: async () => ["/repo"],
    paseoHome: home,
    generation: { generate } as never,
    readDiff: async () => (over.diff === undefined ? file : over.diff),
    readModule: vi.fn(async () => ({
      files: ["weather/cli.py", "weather/__init__.py"],
      text: "Files (2):\nweather/cli.py\nweather/__init__.py",
    })),
    dailyLimit: over.limit ?? 5,
    now: () => new Date("2026-10-08T09:00:00Z"),
  };
  const ask = (n: number, kind: "summary" | "pseudocode" | "module" = "summary", cwd = "/repo") =>
    handlePullRequestReviewExplain({
      msg: {
        type: "checkout.pull-request-review.explain.request",
        requestId: `r${n}`,
        cwd,
        base: BASE,
        head: HEAD,
        path: kind === "module" ? "weather" : "weather.py",
        kind,
      },
      deps,
    });
  return { generate, ask, readModule: deps.readModule };
}

describe("pull request review explanations", () => {
  it("writes once, then every later ask reuses the cached text", async () => {
    const { generate, ask } = setup();
    const first = await ask(1);
    expect(first).toMatchObject({
      status: "ok",
      text: "Prints the rows as a table instead of a raw list.",
      cached: false,
      usedToday: 1,
      dailyLimit: 5,
    });
    expect(await ask(2)).toMatchObject({
      requestId: "r2",
      status: "ok",
      cached: true,
      usedToday: 1,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    // Pseudocode is a different text, so it is its own (cached) entry.
    await ask(3, "pseudocode");
    expect(generate).toHaveBeenCalledTimes(2);
    const prompt = (generate.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("+    print(table(rows))");
    expect(prompt).toContain("untrusted data");
  });

  it("stops at the daily cap and says so, and a failed call still counts once", async () => {
    const failing = setup({ limit: 1, fail: true });
    expect(await failing.ask(1)).toMatchObject({ status: "unavailable", usedToday: 1 });
    expect(await failing.ask(2)).toMatchObject({ status: "limit", usedToday: 1, dailyLimit: 1 });
    expect(failing.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses folders this host doesn't serve and bad commits, and spends nothing on an empty diff", async () => {
    const { generate, ask } = setup({ diff: null });
    expect((await ask(1, "summary", "/elsewhere")).status).toBe("error");
    expect(await ask(2)).toMatchObject({
      status: "ok",
      text: "This file has no text changes to explain.",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("says what a map part does from its files, lists them, and shares the cache and cap", async () => {
    const { generate, ask, readModule } = setup({ limit: 2 });
    expect(await ask(1, "module")).toMatchObject({
      status: "ok",
      cached: false,
      files: ["weather/cli.py", "weather/__init__.py"],
      usedToday: 1,
    });
    expect(readModule).toHaveBeenCalledWith({ cwd: "/repo", commit: HEAD, folder: "weather" });
    const prompt = (generate.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("part of the code in weather does");
    expect(prompt).toContain("weather/__init__.py");
    expect(await ask(2, "module")).toMatchObject({
      cached: true,
      files: ["weather/cli.py", "weather/__init__.py"],
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("picks entry files first, then the shallowest source, and never tests", () => {
    expect(
      pickEntryFiles([
        "weather/tests/test_cli.py",
        "weather/deep/nested/helpers.py",
        "weather/cli.py",
        "weather/__init__.py",
        "weather/cli.test.ts",
        "weather/notes.txt",
        "weather/fetch.py",
      ]),
    ).toEqual(["weather/__init__.py", "weather/cli.py", "weather/fetch.py"]);
  });

  it("renders the diff as unified text for the model", () => {
    expect(diffText(file)).toBe(
      "@@ -3,2 +3,2 @@\n def show(rows):\n-    print(rows)\n+    print(table(rows))",
    );
    expect(diffText(null)).toBe("");
  });
});

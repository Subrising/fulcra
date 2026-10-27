import { describe, expect, it } from "vitest";
import { GitChildLimitError } from "@getpaseo/plugin/server/git";
import { fetchSkipTicksAfterFailures, isDeadWorkspaceFolder, jitterMs } from "./dead-workspace.js";
import { gitFailureLogFields, isKnownGitRefusal } from "./git-known-error.js";

describe("isDeadWorkspaceFolder", () => {
  it("skips a folder that is gone", () => {
    expect(isDeadWorkspaceFolder("/work/gone", () => false)).toBe(true);
  });
  it("keeps an existing folder under /tmp (live sessions work there)", () => {
    expect(isDeadWorkspaceFolder("/tmp/scratch/repo", () => true)).toBe(false);
    expect(isDeadWorkspaceFolder("/private/tmp/scratch/repo", () => true)).toBe(false);
  });
  it("keeps a live folder", () => {
    expect(isDeadWorkspaceFolder("/work/live", () => true)).toBe(false);
  });
});

describe("jitterMs", () => {
  it("spreads a 60 s check between 54 s and 66 s", () => {
    expect(jitterMs(60_000, () => 0)).toBe(54_000);
    expect(jitterMs(60_000, () => 0.5)).toBe(60_000);
    expect(jitterMs(60_000, () => 1)).toBe(66_000);
  });
});

describe("fetchSkipTicksAfterFailures", () => {
  it("backs off only from the third failure, doubling up to 16 ticks", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(fetchSkipTicksAfterFailures)).toEqual([
      0, 0, 1, 2, 4, 8, 16, 16,
    ]);
  });
});

describe("gitFailureLogFields", () => {
  it("logs a known refusal as one line without the error object (no stack)", () => {
    const fields = gitFailureLogFields(new GitChildLimitError(), { cwd: "/a" });
    expect(fields).toEqual({ cwd: "/a", reason: "Fulcra git child limit reached" });
    expect("err" in fields).toBe(false);
  });
  it("keeps the full error for an unknown failure", () => {
    const error = new Error("disk on fire");
    expect(isKnownGitRefusal(error)).toBe(false);
    expect(gitFailureLogFields(error, { cwd: "/a" })).toEqual({ cwd: "/a", err: error });
  });
});

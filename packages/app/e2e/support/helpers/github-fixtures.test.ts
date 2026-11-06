import { describe, expect, it } from "vitest";

import { redactGithubSecrets, runFixtureCommand } from "./github-fixtures";

// FU-695: a fixture error must never carry the GitHub token from the clone URL.
const TOKEN = `ghp_${"A1b2C3d4".repeat(5)}`;

describe("GitHub fixture errors", () => {
  it("masks the token in a clone URL and a bare GitHub token", () => {
    expect(
      redactGithubSecrets(`git clone https://x-access-token:${TOKEN}@github.com/o/r.git /tmp/x`),
    ).toBe("git clone https://x-access-token:***@github.com/o/r.git /tmp/x");
    expect(redactGithubSecrets(`token ${TOKEN} and github_pat_${"x".repeat(30)}`)).toBe(
      "token *** and ***",
    );
    expect(redactGithubSecrets("no secret here")).toBe("no secret here");
  });

  it("keeps the token out of a failed clone's error, stack and properties", () => {
    const url = `https://x-access-token:${TOKEN}@127.0.0.1:9/owner/repo.git`;
    let caught: unknown;
    try {
      runFixtureCommand("git", ["clone", "--quiet", url, "/tmp/fu695-never-created"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toContain("x-access-token:***@127.0.0.1:9");
    const everything = [
      error.message,
      error.stack ?? "",
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      String(error.cause ?? ""),
    ].join("\n");
    expect(everything).not.toContain(TOKEN);
  });
});

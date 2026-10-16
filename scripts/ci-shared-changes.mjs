import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Package-local routes remain in ci-paths.yml. Shared libraries affect every
// consumer. Unknown root files fail closed to the full suite.
export function requiresFullSuite(paths) {
  return paths.some((path) => {
    if (/^packages\/(client|protocol|plugin|highlight|relay)\//.test(path)) return true;
    if (/^(control|plugins|patches|scripts|skills)\//.test(path)) return true;
    if (path.startsWith("packages/")) {
      return !/^packages\/(app|cli|desktop|server|website|expo-two-way-audio)\//.test(path);
    }
    return !/^(docs\/|public-docs\/|\.agents\/|\.github\/|[^/]+\.md$)/.test(path);
  });
}

if (process.env.GITHUB_OUTPUT) {
  let full = true;
  if (process.env.EVENT === "pull_request") {
    const { BASE, HEAD } = process.env;
    if (![BASE, HEAD].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
      throw new Error("Missing PR comparison SHA");
    }
    const paths = execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", `${BASE}...${HEAD}`],
      {
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean);
    full = requiresFullSuite(paths);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
}

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultResolveRemoteUrl } from "../services/forge-cli-command.js";
import { getForgeRemoteUrl } from "./checkout-git.js";

// U5-D07 on a real repository: its only remote is a GitHub remote named `subrising`, as on the U5 checkout. Before the
// fix both lookups read `remote.origin.url` only and returned null ("No supported forge remote").
describe("U5-D07 real git: a GitHub remote not named origin", () => {
  let dir = "";
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "u5-d07-")));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("remote", "add", "subrising", "git@github.com:Subrising/fulcra.git");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("the forge resolver's remote lookup finds it", async () => {
    await expect(defaultResolveRemoteUrl(dir)).resolves.toBe("git@github.com:Subrising/fulcra.git");
  });
  it("the checkout's forge remote (PR review, architecture) finds it", async () => {
    await expect(getForgeRemoteUrl(dir)).resolves.toBe("git@github.com:Subrising/fulcra.git");
  });
});

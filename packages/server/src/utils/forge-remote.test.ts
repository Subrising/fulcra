import { describe, expect, it } from "vitest";
import { isKnownForgeRemoteUrl, resolveForgeRemoteUrl } from "./forge-remote.js";

// A fake `git config --get-regexp ^remote\..*\.url$` over a fixed set of remotes (exit 1, i.e. throws, when there is none).
function fakeGit(remotes: Record<string, string>) {
  return async (args: string[]): Promise<{ stdout: string }> => {
    if (args.join(" ") !== "config --get-regexp ^remote\\..*\\.url$")
      throw new Error(`unexpected git ${args.join(" ")}`);
    const lines = Object.entries(remotes).map(([name, url]) => `remote.${name}.url ${url}`);
    if (!lines.length) throw new Error("exit 1");
    return { stdout: lines.join("\n") + "\n" };
  };
}

describe("U5-D07 forge remote chosen by URL, not by name", () => {
  it("resolves a GitHub remote that is not called origin (the U5 checkout's `subrising`)", async () => {
    await expect(
      resolveForgeRemoteUrl("/w", fakeGit({ subrising: "git@github.com:Subrising/fulcra.git" })),
    ).resolves.toBe("git@github.com:Subrising/fulcra.git");
  });
  it("keeps origin when origin is a forge", async () => {
    await expect(
      resolveForgeRemoteUrl(
        "/w",
        fakeGit({ origin: "https://github.com/a/b.git", upstream: "https://github.com/c/d.git" }),
      ),
    ).resolves.toBe("https://github.com/a/b.git");
  });
  it("prefers the first forge remote by name over a non-forge origin", async () => {
    const remotes = {
      origin: "/srv/mirror/b.git",
      zeta: "git@github.com:z/z.git",
      work: "https://gitlab.com/x/y.git",
    };
    await expect(resolveForgeRemoteUrl("/w", fakeGit(remotes))).resolves.toBe(
      "https://gitlab.com/x/y.git",
    );
  });
  it("keeps origin for a self-hosted forge (the adapters' host probe still decides), and uses a lone remote of any name", async () => {
    await expect(
      resolveForgeRemoteUrl(
        "/w",
        fakeGit({ origin: "git@git.corp.example:a/b.git", other: "/local/b.git" }),
      ),
    ).resolves.toBe("git@git.corp.example:a/b.git");
    await expect(
      resolveForgeRemoteUrl("/w", fakeGit({ company: "https://git.corp.example/a/b.git" })),
    ).resolves.toBe("https://git.corp.example/a/b.git");
  });
  it("returns null with no remote, or several non-forge remotes and no origin", async () => {
    await expect(resolveForgeRemoteUrl("/w", fakeGit({}))).resolves.toBeNull();
    await expect(
      resolveForgeRemoteUrl("/w", fakeGit({ a: "/x/a.git", b: "/x/b.git" })),
    ).resolves.toBeNull();
    await expect(
      resolveForgeRemoteUrl("/w", fakeGit({ subrising: "https://github.com/Subrising/fulcra" })),
    ).resolves.toBe("https://github.com/Subrising/fulcra");
  });
  it("knows the manifest's public forge hosts only", () => {
    expect(isKnownForgeRemoteUrl("ssh://git@github.com/a/b.git")).toBe(true);
    expect(isKnownForgeRemoteUrl("https://gitlab.com/a/b")).toBe(true);
    expect(isKnownForgeRemoteUrl("https://git.corp.example/a/b")).toBe(false);
    expect(isKnownForgeRemoteUrl(null)).toBe(false);
  });
});

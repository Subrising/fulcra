import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkoutProbe } from "./workspace-git-service.js";

describe("checkoutProbe (FU-423)", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  test("tells a deleted folder, a plain folder and a checkout apart without Git", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "checkout-probe-"));
    const plain = path.join(root, "plain"),
      repo = path.join(root, "repo"),
      nested = path.join(repo, "src", "deep");
    await mkdir(plain);
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });

    expect(await checkoutProbe(path.join(root, "deleted"))).toBe("missing");
    expect(await checkoutProbe(plain)).toBe("none");
    expect(await checkoutProbe(repo)).toBe("checkout");
    expect(await checkoutProbe(nested)).toBe("checkout");
  });
});

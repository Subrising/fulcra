import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { saveCommandCentreOwner, ownsCommandCentreSupervisor } from "./command-centre-owner.js";
test("a later app can recognise only the exact private captured supervisor identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cc-owner-"));
  try {
    const owner = {
      pid: 123,
      startedAt: new Date().toISOString(),
      desktopManaged: true,
      listen: "127.0.0.1:12345",
    };
    expect(await ownsCommandCentreSupervisor(root, owner)).toBe(false);
    await saveCommandCentreOwner(root, owner);
    expect(await ownsCommandCentreSupervisor(root, owner)).toBe(true);
    expect(await ownsCommandCentreSupervisor(root, { ...owner, pid: 124 })).toBe(false);
    expect(await ownsCommandCentreSupervisor(root, { ...owner, startedAt: "other" })).toBe(false);
    await chmod(path.join(root, "command-centre-supervisor.json"), 0o644);
    expect(await ownsCommandCentreSupervisor(root, owner)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

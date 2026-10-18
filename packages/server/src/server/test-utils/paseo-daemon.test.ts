import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestPaseoDaemon } from "./paseo-daemon.js";

describe("createTestPaseoDaemon", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  test("skill reconciliation and removal stay inside the scratch daemon home", async () => {
    const ambientHome = await mkdtemp(path.join(os.tmpdir(), "paseo-other-skills-"));
    cleanups.push(() => rm(ambientHome, { recursive: true, force: true }));
    vi.stubEnv("PASEO_SKILLS_HOME", ambientHome);
    const edited = path.join(ambientHome, ".agents", "skills", "paseo", "SKILL.md");
    await mkdir(path.dirname(edited), { recursive: true });
    await writeFile(edited, "user edits");
    const handle = await createTestPaseoDaemon({ mcpEnabled: false });
    cleanups.push(handle.close);
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${handle.port}/ws`,
      clientId: "scratch-skills-test",
      clientType: "browser",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      await client.saveAgentSkillsSelection({ mode: "custom", skills: ["paseo"] });
      await client.reconcileAgentSkills();
      const installed = path.join(
        handle.paseoHome,
        "user-home",
        ".agents",
        "skills",
        "paseo",
        "SKILL.md",
      );
      expect((await readFile(installed, "utf8")).length).toBeGreaterThan(0);
      await client.uninstallAgentSkills();
      expect(existsSync(installed)).toBe(false);
      expect(await readFile(edited, "utf8")).toBe("user edits");
    } finally {
      await client.close();
    }
  }, 60_000);

  test("keeps a caller-owned home when startup on a taken port fails", async () => {
    const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-owned-home-"));
    cleanups.push(() => rm(paseoHomeRoot, { recursive: true, force: true }));
    const ownedFile = path.join(paseoHomeRoot, "owned-by-caller");
    await writeFile(ownedFile, "keep");
    const takenPort = await occupyPort(cleanups);

    await expect(
      createTestPaseoDaemon({
        listenPort: takenPort,
        paseoHomeRoot,
        staticDir: path.join(paseoHomeRoot, "static"),
        cleanup: false,
        mcpEnabled: false,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(existsSync(ownedFile)).toBe(true);
  }, 60_000);

  test("removes the directories it created when startup on a taken port fails", async () => {
    const scratchTmp = await mkdtemp(path.join(os.tmpdir(), "paseo-daemon-scratch-"));
    cleanups.push(() => rm(scratchTmp, { recursive: true, force: true }));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, scratchTmp);
    const takenPort = await occupyPort(cleanups);

    await expect(
      createTestPaseoDaemon({ listenPort: takenPort, cleanup: false, mcpEnabled: false }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(await readdir(scratchTmp)).toEqual([]);
  }, 60_000);
});

async function occupyPort(cleanups: Array<() => Promise<void>>): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Port holder did not bind a TCP port");
  }
  return address.port;
}

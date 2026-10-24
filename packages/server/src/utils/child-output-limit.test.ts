import { once } from "node:events";
import { expect, test } from "vitest";
import { spawnProcess } from "./spawn.js";
import { CodexAppServerClient } from "../server/agent/providers/codex/app-server-transport.js";
import { createTestLogger } from "../test-utils/test-logger.js";

test("spawnProcess fails only the child request when stdout or stderr exceeds 64 MiB without a newline", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const child = spawnProcess(
      process.execPath,
      [
        "-e",
        `
      process.stdin.once('data', async () => {
        const output = process.${stream};
        const chunk = Buffer.alloc(1024 * 1024, 120);
        for (let i = 0; i < 65; i++) {
          if (!output.write(chunk)) await new Promise(r => output.once('drain', r));
        }
        process.exit(0);
      });
    `,
      ],
      { stdio: "pipe" },
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const client = new CodexAppServerClient(child, createTestLogger());
    const request = expect(client.request("thread/resume", {}, 5000)).rejects.toThrow(
      "Child output line exceeds",
    );
    await request;
    await closed;
  }
  const sibling = spawnProcess(process.execPath, ["-e", "console.log('still running')"], {
    stdio: "pipe",
  });
  const output: Buffer[] = [];
  sibling.stdout!.on("data", (chunk) => output.push(chunk));
  await once(sibling, "close");
  expect(Buffer.concat(output).toString()).toBe("still running\n");
});

test("limitChildOutput counts bytes across chunks and preserves bounded lines and split UTF-8", async () => {
  const { ChildProcess } = await import("node:child_process");
  const { PassThrough } = await import("node:stream");
  const { limitChildOutput } = await import("./child-output-limit.js");
  const child = new ChildProcess();
  const raw = new PassThrough();
  child.stdout = raw;
  child.stdio = [null, raw, null, null, null];
  child.kill = () => true;
  const errors: Error[] = [];
  child.on("error", (error) => errors.push(error));
  limitChildOutput(child, 4);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  raw.write(Buffer.from([0xc3]));
  raw.write(Buffer.from([0xa9, 10]));
  raw.write("1234\n1234");
  raw.write("5");
  await once(child.stdout, "end");
  expect(Buffer.concat(chunks).toString()).toBe("é\n1234\n1234");
  expect(errors.map((error) => error.message)).toEqual([
    "Child output line exceeds 4 bytes on stdout; history too large to resume; start a new session",
  ]);
  raw.destroy();
});

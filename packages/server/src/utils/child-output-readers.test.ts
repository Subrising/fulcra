import type { ChildProcess } from "node:child_process";
import { expect, test, vi } from "vitest";

// The shared limiter has a real 64 MiB subprocess test. These cases check each
// reader's wiring with a small limit, so parser work does not race request timers.
vi.mock("./child-output-limit.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./child-output-limit.js")>();
  return {
    ...original,
    limitChildOutput: (child: ChildProcess) => original.limitChildOutput(child, 4096),
  };
});

const observed = vi.hoisted(() => ({ errors: [] as Error[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const source = `
    setImmediate(async () => {
      const out = process.env.OVERSIZED_TEST_STDERR ? process.stderr : process.stdout;
      const chunk = Buffer.alloc(1024, 120);
      for (let i = 0; i < 5; i++) {
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      }
      process.exit(0);
    });
  `;
  return {
    ...original,
    spawn: (
      _command: string,
      _args: string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      const child = original.spawn(process.execPath, ["-e", source], options);
      child.on("error", (error) => observed.errors.push(error));
      return child;
    },
    fork: (_module: string, _args: string[], options: import("node:child_process").ForkOptions) => {
      const child = original.spawn(process.execPath, ["-e", source], {
        ...options,
        env: { ...options.env, OVERSIZED_TEST_STDERR: "1" },
      });
      child.on("error", (error) => observed.errors.push(error));
      return child;
    },
  };
});

import { inspectOutOfProcess } from "../server/directory-access.js";
import { ledgerLease } from "../server/ledger-routing/ledger.js";
import pino from "pino";
import {
  LocalSpeechWorkerClient,
  forkLocalSpeechWorker,
} from "../server/speech/providers/local/worker-client.js";

test("inspectOutOfProcess bounds a malformed child line and leaves the path unreadable", async () => {
  observed.errors.length = 0;
  const result = await inspectOutOfProcess(["/example"], {
    execPath: process.execPath,
    timeoutMs: 5000,
  });
  expect(result.get("/example")).toBe("unreadable");
  expect(observed.errors.map((e) => e.message)).toEqual([
    "Child output line exceeds 4096 bytes on stdout; history too large to resume; start a new session",
  ]);
});

test("ledgerLease refuses an oversized readiness line and closes only its child", async () => {
  observed.errors.length = 0;
  const lease = ledgerLease("/example");
  expect(await lease.ready).toBe(false);
  await lease.close();
  expect(lease.alive()).toBe(false);
  expect(observed.errors.map((e) => e.message)).toEqual([
    "Child output line exceeds 4096 bytes on stdout; history too large to resume; start a new session",
  ]);
});

test("forkLocalSpeechWorker bounds stderr before its line reader receives it", async () => {
  observed.errors.length = 0;
  const child = forkLocalSpeechWorker() as ChildProcess;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stderr!.resume();
  await closed;
  expect(observed.errors.map((e) => e.message)).toEqual([
    "Child output line exceeds 4096 bytes on stderr; history too large to resume; start a new session",
  ]);
});

test("ensureWorker preserves the output-limit reason when its speech request fails", async () => {
  const client = new LocalSpeechWorkerClient({
    logger: pino({ level: "silent" }),
    config: {
      modelsDir: "/unused",
      voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
      dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
      voiceTtsModel: "kokoro-en-v0_19",
    },
    requestTimeoutMs: 10000,
  });
  await expect(client.synthesizeSpeech("test")).rejects.toThrow("Child output line exceeds");
});

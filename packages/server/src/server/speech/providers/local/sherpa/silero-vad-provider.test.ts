import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import {
  ensureSileroVadModel,
  hasCompleteSileroVadModel,
  SILERO_VAD_SIZE,
} from "./silero-vad-provider.js";

it("provisions the real bundled VAD, rejects same-size corruption, and repairs it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fulcra-vad-"));
  try {
    expect(await hasCompleteSileroVadModel(root)).toBe(false);
    await mkdir(path.join(root, "silero-vad"));
    await writeFile(
      path.join(root, "silero-vad", "silero_vad.onnx"),
      Buffer.alloc(SILERO_VAD_SIZE),
    );
    expect(await hasCompleteSileroVadModel(root)).toBe(false);
    await ensureSileroVadModel(root, pino({ level: "silent" }));
    expect(await hasCompleteSileroVadModel(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

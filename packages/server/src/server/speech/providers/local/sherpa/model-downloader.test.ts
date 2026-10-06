import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { recordModelCompletion, hasCompleteModelFiles } from "./model-integrity.js";
import { ensureSherpaOnnxModel, getSherpaOnnxModelDir } from "./model-downloader.js";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-speech-models-"));
}

const logger = pino({ level: "silent" });

describe("sherpa model downloader", () => {
  test("getSherpaOnnxModelDir maps modelId to extractedDir", () => {
    const modelsDir = "/tmp/models";
    expect(getSherpaOnnxModelDir(modelsDir, "parakeet-tdt-0.6b-v2-int8")).toContain(
      "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    );
    expect(getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19")).toContain("kokoro-en-v0_19");
  });

  test("ensureSherpaOnnxModel succeeds without downloading when files exist", async () => {
    const modelsDir = makeTmpDir();
    const modelDir = getSherpaOnnxModelDir(modelsDir, "kokoro-en-v0_19");

    mkdirSync(path.join(modelDir, "espeak-ng-data"), { recursive: true });
    writeFileSync(path.join(modelDir, "espeak-ng-data", "phondata"), "fixture-data");
    writeFileSync(path.join(modelDir, "model.onnx"), "x");
    writeFileSync(path.join(modelDir, "voices.bin"), "x");
    writeFileSync(path.join(modelDir, "tokens.txt"), "x");

    await recordModelCompletion(modelDir, [
      "model.onnx",
      "voices.bin",
      "tokens.txt",
      "espeak-ng-data",
    ]);
    const out = await ensureSherpaOnnxModel({
      modelsDir,
      modelId: "kokoro-en-v0_19",
      logger,
    });

    expect(out).toBe(modelDir);
  });
});

test("complete model verification detects nonempty truncation and incomplete recursive data", async () => {
  const root = makeTmpDir();
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(root, "model.onnx"), "complete-fixture-model");
  writeFileSync(path.join(root, "data", "phondata"), "complete-fixture-data");
  const required = ["model.onnx", "data"];
  expect(await hasCompleteModelFiles(root, required)).toBe(false);
  await recordModelCompletion(root, required);
  expect(await hasCompleteModelFiles(root, required)).toBe(true);
  writeFileSync(path.join(root, "model.onnx"), "x");
  expect(await hasCompleteModelFiles(root, required)).toBe(false);
});

import { copyFile, mkdir, lstat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../../turn-detection-provider.js";
import {
  resolveBundledSileroVadModelPath,
  SherpaSileroVadSession,
  type SherpaSileroVadSessionConfig,
} from "./silero-vad-session.js";

const SILERO_VAD_DIR = "silero-vad";
const SILERO_VAD_FILE = "silero_vad.onnx";

export const SILERO_VAD_SIZE = 643854;
export const SILERO_VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";
export async function hasCompleteSileroVadModel(modelsDir: string): Promise<boolean> {
  try {
    const file = path.join(modelsDir, SILERO_VAD_DIR, SILERO_VAD_FILE);
    const info = await lstat(file);
    if (!info.isFile() || info.size !== SILERO_VAD_SIZE) return false;
    return (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") === SILERO_VAD_SHA256
    );
  } catch {
    return false;
  }
}

/** Copy the verified bundled dependency out of ASAR before declaring speech ready. */
export async function ensureSileroVadModel(modelsDir: string, logger: Logger): Promise<string> {
  const destDir = path.join(modelsDir, SILERO_VAD_DIR);
  const destPath = path.join(destDir, SILERO_VAD_FILE);
  if (await hasCompleteSileroVadModel(modelsDir)) return destPath;
  await mkdir(destDir, { recursive: true });
  const temporaryDir = path.join(modelsDir, `.silero-${randomUUID()}`);
  await mkdir(temporaryDir);
  try {
    const temporaryModelDir = path.join(temporaryDir, SILERO_VAD_DIR);
    await mkdir(temporaryModelDir);
    const temporaryFile = path.join(temporaryModelDir, SILERO_VAD_FILE);
    await copyFile(resolveBundledSileroVadModelPath(), temporaryFile);
    if (!(await hasCompleteSileroVadModel(temporaryDir)))
      throw Error("Bundled Silero VAD model is incomplete");
    await rename(temporaryFile, destPath);
    logger.info("Provisioned verified Silero VAD model");
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  return destPath;
}

export class SherpaSileroTurnDetectionProvider implements TurnDetectionProvider {
  public readonly id = "local" as const;

  private readonly config: SherpaSileroVadSessionConfig;
  private readonly logger: Logger;

  constructor(config: SherpaSileroVadSessionConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({
      module: "speech",
      provider: "local",
      component: "silero-vad",
    });
  }

  createSession(params: { logger: Logger }): TurnDetectionSession {
    this.logger.debug(
      { sampleRate: this.config.sampleRate, modelPath: this.config.modelPath },
      "Creating Silero VAD turn-detection session",
    );
    return new SherpaSileroVadSession({
      logger: params.logger.child({
        provider: "local",
        component: "silero-vad-session",
      }),
      config: this.config,
    });
  }
}

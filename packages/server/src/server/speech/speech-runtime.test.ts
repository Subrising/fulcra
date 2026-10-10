import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { PaseoSpeechConfig } from "../bootstrap.js";
import type { InitializedLocalSpeech } from "./providers/local/runtime.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech-provider.js";
import type { TurnDetectionProvider } from "./turn-detection-provider.js";
import { createSpeechService, findMissingRequiredLocalModels } from "./speech-runtime.js";

const { ensureLocalSpeechModelsMock, initializeLocalSpeechServicesMock } = vi.hoisted(() => ({
  ensureLocalSpeechModelsMock: vi.fn(async () => ({})),
  initializeLocalSpeechServicesMock: vi.fn<(args: unknown) => Promise<InitializedLocalSpeech>>(),
}));

vi.mock("./providers/local/runtime.js", () => ({
  initializeLocalSpeechServices: initializeLocalSpeechServicesMock,
}));

vi.mock("./providers/openai/runtime.js", () => ({
  getOpenAiSpeechAvailability: () => ({ configured: false }),
  initializeOpenAiSpeechServices: (args: {
    existing: {
      turnDetectionService: TurnDetectionProvider | null;
      sttService: SpeechToTextProvider | null;
      ttsService: TextToSpeechProvider | null;
      dictationSttService: SpeechToTextProvider | null;
    };
  }) => ({
    turnDetectionService: args.existing.turnDetectionService,
    sttService: args.existing.sttService,
    ttsService: args.existing.ttsService,
    dictationSttService: args.existing.dictationSttService,
  }),
  validateOpenAiCredentialRequirements: () => {},
}));

vi.mock("./providers/local/models.js", () => ({
  ensureLocalSpeechModels: ensureLocalSpeechModelsMock,
  listMissingLocalSpeechModels: vi.fn(async ({ modelIds }: { modelIds: string[] }) => modelIds),
}));

function createStubStt(id: string): SpeechToTextProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTts(id: string): TextToSpeechProvider {
  return {
    id,
    synthesizeSpeech: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
  };
}

function createStubTurnDetection(id: string): TurnDetectionProvider {
  return {
    id,
    createSession: vi.fn(() => {
      throw new Error("not used in this test");
    }),
  };
}

function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function createSpeechConfig(providers: PaseoSpeechConfig["providers"]): PaseoSpeechConfig {
  return {
    providers,
    sttLanguages: {
      dictation: "en",
      voice: "en",
    },
  };
}

describe("createSpeechService readiness", () => {
  beforeEach(() => {
    ensureLocalSpeechModelsMock.mockReset();
    ensureLocalSpeechModelsMock.mockResolvedValue({});
    initializeLocalSpeechServicesMock.mockReset();
  });

  it("keeps voice feature available when only dictation is enabled and ready", async () => {
    const dictationStt = createStubStt("dictation-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: dictationStt,
      localVoiceTtsProvider: null,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.dictation.available).toBe(true);
    expect(readiness.realtimeVoice.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    await runtime.stop();
  });

  it("keeps voice feature available when only realtime voice is enabled and ready", async () => {
    const voiceStt = createStubStt("voice-local");
    const voiceTts = createStubTts("tts-local");
    const turnDetection = createStubTurnDetection("turn-local");

    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: turnDetection,
      sttService: voiceStt,
      ttsService: voiceTts,
      dictationSttService: null,
      localVoiceTtsProvider: voiceTts,
      localModelConfig: null,
      availability: {
        configured: false,
        modelsDir: null,
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: false, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: true, explicit: true },
        voiceStt: { provider: "local", enabled: true, explicit: true },
        voiceTts: { provider: "local", enabled: true, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;

    const readiness = runtime.getReadiness();
    expect(readiness.realtimeVoice.available).toBe(true);
    expect(readiness.dictation.reasonCode).toBe("disabled");
    expect(readiness.voiceFeature.available).toBe(true);
    expect(readiness.voiceFeature.reasonCode).toBe("ready");

    await runtime.stop();
  });

  it("aborts and joins an in-flight model download when stopped", async () => {
    let downloadSignal: AbortSignal | undefined;
    ensureLocalSpeechModelsMock.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      downloadSignal = signal;
      return rejectWhenAborted(signal);
    });
    initializeLocalSpeechServicesMock.mockResolvedValue({
      turnDetectionService: null,
      sttService: null,
      ttsService: null,
      dictationSttService: null,
      localVoiceTtsProvider: null,
      localModelConfig: {
        modelsDir: "/tmp/missing-local-speech-models",
        defaultModelIds: ["parakeet-tdt-0.6b-v2-int8"],
      },
      availability: {
        configured: true,
        modelsDir: "/tmp/missing-local-speech-models",
      },
      cleanup: () => {},
    });

    const runtime = createSpeechService({
      logger: pino({ level: "silent" }),
      speechConfig: createSpeechConfig({
        dictationStt: { provider: "local", enabled: true, explicit: true },
        voiceTurnDetection: { provider: "local", enabled: false, explicit: true },
        voiceStt: { provider: "local", enabled: false, explicit: true },
        voiceTts: { provider: "local", enabled: false, explicit: true },
      }),
    });
    runtime.start();
    await runtime.ready;
    expect(ensureLocalSpeechModelsMock).toHaveBeenCalledOnce();

    await runtime.stop();

    expect(downloadSignal?.aborted).toBe(true);
  });
});

it("detects VAD-only absence even when every selected STT component is complete", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { listLocalSpeechModels, getLocalSpeechModelDir } =
    await import("./providers/local/models.js");
  const { listSherpaOnnxModels } = await import("./providers/local/sherpa/model-catalog.js");
  const { recordModelCompletion } = await import("./providers/local/sherpa/model-integrity.js");
  const { ensureSileroVadModel } = await import("./providers/local/sherpa/silero-vad-provider.js");
  const root = await mkdtemp(path.join(tmpdir(), "fulcra-speech-readiness-"));
  const modelId = "parakeet-tdt-0.6b-v2-int8";
  const specs = listSherpaOnnxModels();
  const spec = specs.find((model) => model.id === modelId)!;
  const modelDir = path.join(root, spec.extractedDir);
  try {
    await mkdir(modelDir);
    for (const file of spec.requiredFiles)
      await writeFile(path.join(modelDir, file), "complete component fixture");
    await recordModelCompletion(modelDir, spec.requiredFiles);
    vi.mocked(listLocalSpeechModels).mockReturnValue(specs);
    vi.mocked(getLocalSpeechModelDir).mockReturnValue(modelDir);
    expect(
      await findMissingRequiredLocalModels({ modelsDir: root, requiredModelIds: [modelId] }),
    ).toEqual([modelId]);
    await ensureSileroVadModel(root, pino({ level: "silent" }));
    expect(
      await findMissingRequiredLocalModels({ modelsDir: root, requiredModelIds: [modelId] }),
    ).toEqual([]);
  } finally {
    vi.mocked(listLocalSpeechModels).mockReturnValue([]);
    vi.mocked(getLocalSpeechModelDir).mockReturnValue("");
    await rm(root, { recursive: true, force: true });
  }
});

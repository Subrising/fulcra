import type { SpeechSpan } from "./dictation-speech-trim.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import { resolveBundledSileroVadModelPath } from "./silero-vad-session.js";

const WINDOW_SIZE = 512;
const BUFFER_SIZE_SECONDS = 30;
// A lower threshold than turn detection: trimming must not cut quiet speech.
const SPAN_THRESHOLD = 0.35;
const MIN_SILENCE_SECONDS = 0.25;
const MIN_SPEECH_SECONDS = 0.1;

interface SherpaVadSegment {
  start: number;
  samples: Float32Array;
}

interface SherpaSpanVadHandle {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): SherpaVadSegment;
  pop(): void;
  flush(): void;
  reset(): void;
}

interface SherpaSpanVadModule {
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaSpanVadHandle;
}

export interface SpeechSpanDetector {
  detect(samples: Float32Array): SpeechSpan[];
}

/** Finds voiced spans in a whole buffer with Silero VAD. */
export class SileroSpeechSpanDetector implements SpeechSpanDetector {
  private readonly vad: SherpaSpanVadHandle;

  constructor(params: { modelPath?: string; sampleRate: number; threshold?: number }) {
    const sherpa = loadSherpaOnnxNode() as unknown as SherpaSpanVadModule;
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: params.modelPath ?? resolveBundledSileroVadModelPath(),
          threshold: params.threshold ?? SPAN_THRESHOLD,
          minSilenceDuration: MIN_SILENCE_SECONDS,
          minSpeechDuration: MIN_SPEECH_SECONDS,
          windowSize: WINDOW_SIZE,
        },
        sampleRate: params.sampleRate,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      BUFFER_SIZE_SECONDS,
    );
  }

  detect(samples: Float32Array): SpeechSpan[] {
    const spans: SpeechSpan[] = [];
    this.vad.reset();
    try {
      for (let offset = 0; offset + WINDOW_SIZE <= samples.length; offset += WINDOW_SIZE) {
        this.vad.acceptWaveform(samples.subarray(offset, offset + WINDOW_SIZE));
        this.drain(spans);
      }
      this.vad.flush();
      this.drain(spans);
    } finally {
      this.vad.reset();
    }
    return spans;
  }

  private drain(spans: SpeechSpan[]): void {
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false);
      spans.push({ start: segment.start, end: segment.start + segment.samples.length });
      this.vad.pop();
    }
  }
}

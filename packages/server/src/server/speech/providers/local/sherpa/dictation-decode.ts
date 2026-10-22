import { pcm16leToFloat32 } from "../../../audio.js";
import {
  DICTATION_TRAILING_WORD_GRACE_MS,
  dropWordsAfter,
  lastSpeechEndSec,
  padWithSilence,
} from "./dictation-speech-trim.js";
import type { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";
import type { SpeechSpanDetector } from "./silero-speech-spans.js";

const TARGET_PEAK = 0.6;
const MAX_GAIN = 50;

type DictationDecodeEngine = Pick<
  SherpaOfflineRecognizerEngine,
  "createStream" | "acceptWaveform" | "recognizer" | "sampleRate"
>;

interface RecognizerOutput {
  text: string;
  tokens: string[];
  timestamps: number[];
}

/** Partial decode: the whole buffer, peak-normalised, as before. */
export function decodeDictationPartial(engine: DictationDecodeEngine, pcm16: Buffer): string {
  if (pcm16.length === 0) {
    return "";
  }
  return runRecognizer(engine, normalisePeak(pcm16leToFloat32(pcm16, 1))).text;
}

/**
 * Final decode: the whole buffer plus trailing silence, so the model can close
 * the last word. Words that start after the last voiced span are dropped. When
 * the VAD finds no speech, the model text is kept so quiet dictation is not lost.
 */
export function decodeDictationFinal(params: {
  engine: DictationDecodeEngine;
  detector: SpeechSpanDetector;
  pcm16: Buffer;
}): string {
  const { engine, detector, pcm16 } = params;
  if (pcm16.length === 0) {
    return "";
  }
  const samples = normalisePeak(pcm16leToFloat32(pcm16, 1));
  const output = runRecognizer(engine, padWithSilence({ samples, sampleRate: engine.sampleRate }));
  const speechEndSec = lastSpeechEndSec(detector.detect(samples), engine.sampleRate);
  if (speechEndSec === null) {
    return output.text;
  }
  const cutoffSec = speechEndSec + DICTATION_TRAILING_WORD_GRACE_MS / 1000;
  return dropWordsAfter({ ...output, cutoffSec }) ?? output.text;
}

function normalisePeak(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
  }
  if (peak <= 0 || peak >= TARGET_PEAK) {
    return samples;
  }
  const gain = Math.min(MAX_GAIN, TARGET_PEAK / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

function runRecognizer(engine: DictationDecodeEngine, samples: Float32Array): RecognizerOutput {
  const stream = engine.createStream();
  try {
    engine.acceptWaveform(stream, engine.sampleRate, samples);
    engine.recognizer.decode(stream);
    return readResult(engine.recognizer.getResult(stream));
  } finally {
    try {
      stream.free?.();
    } catch {
      // ignore
    }
  }
}

function readResult(result: unknown): RecognizerOutput {
  if (typeof result === "string") {
    return { text: result.trim(), tokens: [], timestamps: [] };
  }
  if (!result || typeof result !== "object") {
    return { text: "", tokens: [], timestamps: [] };
  }
  const record = result as { text?: unknown; tokens?: unknown; timestamps?: unknown };
  return {
    text: typeof record.text === "string" ? record.text.trim() : "",
    tokens: Array.isArray(record.tokens) ? record.tokens.map(String) : [],
    timestamps: Array.isArray(record.timestamps) ? record.timestamps.map(Number) : [],
  };
}

import { describe, expect, it } from "vitest";

import { decodeDictationFinal } from "./dictation-decode.js";
import type { SpeechSpan } from "./dictation-speech-trim.js";

interface FakeResult {
  text: string;
  tokens: string[];
  timestamps: number[];
}

function fakeEngine(result: FakeResult) {
  const decoded: Float32Array[] = [];
  const engine = {
    sampleRate: 16000,
    createStream: () => ({ acceptWaveform: () => undefined }),
    acceptWaveform: (_stream: unknown, _rate: number, samples: Float32Array) => {
      decoded.push(samples);
    },
    recognizer: {
      decode: () => undefined,
      getResult: () => result,
    },
  };
  return { engine, decoded };
}

function pcm(samples: number): Buffer {
  const out = new Int16Array(samples);
  out.fill(1000);
  return Buffer.from(out.buffer);
}

const tailYeah: FakeResult = {
  text: "Open the file. Yeah.",
  tokens: [" Open", " the", " file", ".", " Yeah", "."],
  timestamps: [0, 0.32, 0.64, 0.96, 1.6, 1.68],
};

describe("decodeDictationFinal", () => {
  it("pads the buffer with silence and drops words after the last voiced span", () => {
    const { engine, decoded } = fakeEngine(tailYeah);
    const spans: SpeechSpan[] = [{ start: 0, end: 16000 }];
    const text = decodeDictationFinal({
      engine: engine as never,
      detector: { detect: () => spans },
      pcm16: pcm(32000),
    });
    expect(text).toBe("Open the file.");
    expect(decoded[0].length).toBe(32000 + 8000);
    expect(decoded[0].subarray(32000).every((sample) => sample === 0)).toBe(true);
  });

  it("keeps the model text when the VAD finds no speech", () => {
    const { engine } = fakeEngine(tailYeah);
    const text = decodeDictationFinal({
      engine: engine as never,
      detector: { detect: () => [] },
      pcm16: pcm(32000),
    });
    expect(text).toBe("Open the file. Yeah.");
  });
});

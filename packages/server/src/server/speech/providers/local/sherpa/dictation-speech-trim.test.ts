import { describe, expect, it } from "vitest";

import { dropWordsAfter, lastSpeechEndSec, padWithSilence } from "./dictation-speech-trim.js";

describe("lastSpeechEndSec", () => {
  it("returns the end of the latest voiced span in seconds", () => {
    const spans = [
      { start: 1600, end: 16000 },
      { start: 20000, end: 24000 },
    ];
    expect(lastSpeechEndSec(spans, 16000)).toBe(1.5);
  });

  it("returns null when no span is voiced", () => {
    expect(lastSpeechEndSec([], 16000)).toBeNull();
    expect(lastSpeechEndSec([{ start: 100, end: 100 }], 16000)).toBeNull();
  });
});

describe("padWithSilence", () => {
  it("appends zeros after the samples", () => {
    const padded = padWithSilence({
      samples: Float32Array.from([0.5, -0.5]),
      sampleRate: 16000,
      padMs: 500,
    });
    expect(padded.length).toBe(2 + 8000);
    expect(Array.from(padded.subarray(0, 2))).toEqual([0.5, -0.5]);
    expect(padded.subarray(2).every((sample) => sample === 0)).toBe(true);
  });
});

describe("dropWordsAfter", () => {
  it("drops a word that starts after the cutoff", () => {
    const text = dropWordsAfter({
      tokens: [" Open", " the", " file", ".", " Yeah", "."],
      timestamps: [0, 0.32, 0.64, 0.96, 1.6, 1.68],
      cutoffSec: 1.2,
    });
    expect(text).toBe("Open the file.");
  });

  it("keeps the rest of a word that starts before the cutoff", () => {
    const text = dropWordsAfter({
      tokens: [" Run", " the", " min", "i", "."],
      timestamps: [0, 0.32, 1.04, 1.28, 1.36],
      cutoffSec: 1.1,
    });
    expect(text).toBe("Run the mini.");
  });

  it("returns null when tokens and timestamps do not line up", () => {
    expect(dropWordsAfter({ tokens: [" a"], timestamps: [], cutoffSec: 1 })).toBeNull();
    expect(dropWordsAfter({ tokens: [], timestamps: [], cutoffSec: 1 })).toBeNull();
  });
});

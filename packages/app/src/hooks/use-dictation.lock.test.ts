import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PCM_DICTATION_FORMAT } from "./use-dictation.shared";

// Voice lock. Dictation method changes need the owner's approval (decision log, 10 Oct).
// These checks fail if phone composer dictation stops using host transcription:
// the host stream is bypassed, an on-device engine is added, or a recording is cut.

const SRC = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(SRC, relative), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("dictation voice lock", () => {
  const hook = read("hooks/use-dictation.ts");

  it("keeps the host PCM stream format", () => {
    expect(PCM_DICTATION_FORMAT).toBe("audio/pcm;rate=16000;bits=16");
    expect(hook).toContain("format: PCM_DICTATION_FORMAT");
  });

  it("sends every captured segment to the host stream sender", () => {
    expect(hook).toContain('from "@/dictation/dictation-stream-sender"');
    expect(hook).toMatch(
      /onPcmSegment:\s*\(audioData\)\s*=>\s*\{\s*senderRef\.current\?\.enqueueSegment\(audioData\)/,
    );
  });

  it("takes the final text from the host, after all segments are sent", () => {
    expect(hook).toMatch(/senderRef\.current!\.finish\(finalSeq\)/);
    expect(hook).toMatch(/finalSeq = senderRef\.current\?\.getFinalSeq\(\)/);
    expect(hook).toContain("result.text");
  });

  it("does not use an on-device speech engine", () => {
    const banned =
      /expo-speech-recognition|@react-native-voice|react-native-voice|SpeechRecognizer|SFSpeechRecognizer|webkitSpeechRecognition|\bSpeechRecognition\b|whisper\.rn|react-native-whisper/;
    const offenders = sourceFiles(SRC).filter((file) => banned.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
    const pkg = readFileSync(path.resolve(SRC, "../package.json"), "utf8");
    expect(pkg).not.toMatch(banned);
  }, 60_000);
});

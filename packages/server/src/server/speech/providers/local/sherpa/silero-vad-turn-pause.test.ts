import pino from "pino";
import { beforeEach, expect, it, vi } from "vitest";

// FULCRA(core-fixes): a 60 s spoken message with normal 2.5 s thinking pauses. At the detector's old 1 s pause it
// was cut into one turn per sentence, and each new turn interrupted the agent's answer to the one before. The voice
// turn now ends only after VOICE_TURN_PAUSE_MS (4 s), so the whole message is one turn. The Silero model is replaced
// by a script that says when speech is heard; the session's own boundary logic is the code under test.

const script = vi.hoisted(() => ({ windows: 0, speaking: (_ms: number) => false }));

vi.mock("./sherpa-onnx-node-loader.js", () => ({
  loadSherpaOnnxNode: () => ({
    Vad: class {
      acceptWaveform() {
        script.windows += 1;
      }
      isDetected() {
        return script.speaking(script.windows * 32);
      }
      isEmpty() {
        return true;
      }
      flush() {}
      reset() {}
    },
    CircularBuffer: class {
      private samples = 0;
      push(chunk: Float32Array) {
        this.samples += chunk.length;
      }
      get(_start: number, n: number) {
        return new Float32Array(n);
      }
      pop(n: number) {
        this.samples -= n;
      }
      size() {
        return this.samples;
      }
      head() {
        return 0;
      }
      reset() {
        this.samples = 0;
      }
    },
  }),
}));

import { VOICE_TURN_PAUSE_MS } from "../../../turn-detection-provider.js";
import { SherpaSileroTurnDetectionProvider } from "./silero-vad-provider.js";

const logger = pino({ level: "silent" });
// Six 8 s sentences, each followed by a 2.5 s pause: 63 s in all. Then 6 s of silence.
const SENTENCE_MS = 8000;
const PAUSE_MS = 2500;
const SENTENCES = 6;
const SPEECH_END_MS = SENTENCES * (SENTENCE_MS + PAUSE_MS);

function speakSixtySeconds(silenceMs?: number) {
  script.windows = 0;
  script.speaking = (ms) => ms < SPEECH_END_MS && ms % (SENTENCE_MS + PAUSE_MS) < SENTENCE_MS;
  const session = new SherpaSileroTurnDetectionProvider({}, logger).createSession({
    logger,
    ...(silenceMs ? { silenceMs } : {}),
  });
  const events: string[] = [];
  session.on("speech_started", () => events.push("started"));
  session.on("speech_stopped", () => events.push("stopped"));
  void session.connect();
  // 100 ms chunks of 16 kHz PCM16, as the phone sends them.
  const chunk = Buffer.alloc(3200);
  for (let ms = 0; ms < SPEECH_END_MS + 6000; ms += 100) session.appendPcm16(chunk);
  return events;
}

beforeEach(() => {
  script.windows = 0;
});

it("keeps a 60 s message with 2.5 s pauses as one turn at the voice-mode pause", () => {
  expect(VOICE_TURN_PAUSE_MS).toBe(4000);
  expect(speakSixtySeconds(VOICE_TURN_PAUSE_MS)).toEqual(["started", "stopped"]);
});

it("the detector's own 1 s default cut the same message into one turn per sentence", () => {
  expect(speakSixtySeconds()).toEqual(
    Array.from({ length: SENTENCES }, () => ["started", "stopped"]).flat(),
  );
});

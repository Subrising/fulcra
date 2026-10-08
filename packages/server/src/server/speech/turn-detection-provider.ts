import type pino from "pino";

export interface TurnDetectionSession {
  /**
   * Required PCM16LE sample rate for `appendPcm16()`.
   * Callers are responsible for resampling before appending.
   */
  requiredSampleRate: number;

  connect(): Promise<void>;
  appendPcm16(pcm16le: Buffer): void;
  flush(): void;
  reset(): void;
  close(): void;

  on(event: "speech_started", handler: () => void): unknown;
  on(event: "speech_stopped", handler: () => void): unknown;
  on(event: "error", handler: (err: unknown) => void): unknown;
}

export interface TurnDetectionProvider {
  id: "openai" | "local" | (string & {});
  /** `silenceMs`: silence that ends a turn. Providers without a setting ignore it. */
  createSession(params: { logger: pino.Logger; silenceMs?: number }): TurnDetectionSession;
}

// FULCRA(core-fixes): a voice-mode turn ends after this much silence. At 1 s (the detector's own default) a long
// spoken message with normal thinking pauses was cut into several turns, and each new turn interrupted the agent's
// answer to the one before. Settable with features.voiceMode.turnDetection.pauseMs.
export const VOICE_TURN_PAUSE_MS = 4000;

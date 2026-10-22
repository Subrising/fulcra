// Dictation audio ends where the user lets go of the button. When the buffer
// stops hard on the last word, Parakeet can drop or change that word, and noise
// after the last word can decode as a stray word. The final decode therefore
// pads the buffer with digital silence and drops any word that the model
// places after the last voiced span.

export interface SpeechSpan {
  /** First voiced sample (inclusive). */
  start: number;
  /** Last voiced sample (exclusive). */
  end: number;
}

export const DICTATION_SILENCE_PAD_MS = 500;
/** A word must start no later than this after the last voiced span ends. */
export const DICTATION_TRAILING_WORD_GRACE_MS = 240;

/** End of the last voiced span in seconds, or null when nothing is voiced. */
export function lastSpeechEndSec(spans: readonly SpeechSpan[], sampleRate: number): number | null {
  let end = -1;
  for (const span of spans) {
    if (span.end > span.start && span.end > end) {
      end = span.end;
    }
  }
  return end < 0 ? null : end / sampleRate;
}

/** Returns `samples` followed by `padMs` of zeros. */
export function padWithSilence(params: {
  samples: Float32Array;
  sampleRate: number;
  padMs?: number;
}): Float32Array {
  const padMs = params.padMs ?? DICTATION_SILENCE_PAD_MS;
  const pad = Math.round((padMs / 1000) * params.sampleRate);
  const out = new Float32Array(params.samples.length + pad);
  out.set(params.samples, 0);
  return out;
}

export interface TimedTokens {
  tokens: readonly string[];
  timestamps: readonly number[];
}

/**
 * Rebuilds the transcript from model tokens and drops every word whose first
 * token starts after `cutoffSec`. A word starts at a token with a leading
 * space (sherpa-onnx maps the SentencePiece word marker to a space). Returns
 * null when the token and timestamp arrays do not line up, so the caller can
 * keep the model text.
 */
export function dropWordsAfter(params: TimedTokens & { cutoffSec: number }): string | null {
  const { tokens, timestamps } = params;
  if (tokens.length === 0 || tokens.length !== timestamps.length) {
    return null;
  }
  let keepUntil = tokens.length;
  for (let i = 0; i < tokens.length; i += 1) {
    const startsWord = i === 0 || tokens[i].startsWith(" ");
    if (startsWord && timestamps[i] > params.cutoffSec) {
      keepUntil = i;
      break;
    }
  }
  return tokens.slice(0, keepUntil).join("").trim();
}

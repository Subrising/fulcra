import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";

import type { StreamingTranscriptionSession } from "../../../speech-provider.js";
import { decodeDictationFinal, decodeDictationPartial } from "./dictation-decode.js";
import { SherpaOfflineRecognizerEngine } from "./sherpa-offline-recognizer.js";
import type { SpeechSpanDetector } from "./silero-speech-spans.js";

export class SherpaParakeetRealtimeTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  private readonly engine: SherpaOfflineRecognizerEngine;
  private readonly speechSpans: SpeechSpanDetector;
  private connected = false;

  public readonly requiredSampleRate: number;
  private currentSegmentId: string | null = null;
  private previousSegmentId: string | null = null;
  private lastPartialText = "";

  private pcm16: Buffer = Buffer.alloc(0);
  private lastDecodeAt = 0;
  private decoding = false;
  private pendingDecode = false;
  private readonly minDecodeIntervalMs: number;

  constructor(params: {
    engine: SherpaOfflineRecognizerEngine;
    speechSpans: SpeechSpanDetector;
    minDecodeIntervalMs?: number;
  }) {
    super();
    this.engine = params.engine;
    this.speechSpans = params.speechSpans;
    this.requiredSampleRate = this.engine.sampleRate;
    this.minDecodeIntervalMs = params.minDecodeIntervalMs ?? 350;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.currentSegmentId = uuidv4();
    this.connected = true;
  }

  appendPcm16(chunk: Buffer): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit("error", new Error("Parakeet realtime session not connected"));
      return;
    }

    try {
      this.pcm16 = this.pcm16.length === 0 ? chunk : Buffer.concat([this.pcm16, chunk]);
      void this.maybeDecode(false);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  commit(): void {
    if (!this.connected || !this.currentSegmentId) {
      this.emit("error", new Error("Parakeet realtime session not connected"));
      return;
    }

    void (async () => {
      try {
        const finalText = decodeDictationFinal({
          engine: this.engine,
          detector: this.speechSpans,
          pcm16: this.pcm16,
        });
        const segmentId = this.currentSegmentId!;
        const previousSegmentId = this.previousSegmentId;

        this.emit("committed", { segmentId, previousSegmentId });
        this.emit("transcript", { segmentId, transcript: finalText, isFinal: true });

        this.previousSegmentId = segmentId;
        this.currentSegmentId = uuidv4();
        this.lastPartialText = "";
        this.pcm16 = Buffer.alloc(0);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  clear(): void {
    if (!this.connected) {
      return;
    }
    this.pcm16 = Buffer.alloc(0);
    this.currentSegmentId = uuidv4();
    this.lastPartialText = "";
  }

  close(): void {
    this.connected = false;
    this.currentSegmentId = null;
    this.pcm16 = Buffer.alloc(0);
  }

  private async maybeDecode(force: boolean): Promise<void> {
    if (!this.connected || !this.currentSegmentId) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastDecodeAt < this.minDecodeIntervalMs) {
      return;
    }

    if (this.decoding) {
      this.pendingDecode = true;
      return;
    }

    this.decoding = true;
    try {
      const text = await this.decodeNow();
      this.lastDecodeAt = Date.now();
      if (text !== this.lastPartialText) {
        this.lastPartialText = text;
        this.emit("transcript", {
          segmentId: this.currentSegmentId,
          transcript: text,
          isFinal: false,
        });
      }
    } finally {
      this.decoding = false;
      if (this.pendingDecode) {
        this.pendingDecode = false;
        await this.maybeDecode(true);
      }
    }
  }

  private async decodeNow(): Promise<string> {
    return decodeDictationPartial(this.engine, this.pcm16);
  }
}

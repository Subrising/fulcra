export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
}

export interface DictationAudioStopOptions {
  /** Keep capturing this long before closing the mic, so audio still in the device pipeline is kept. */
  tailMs?: number;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  stop: (options?: DictationAudioStopOptions) => Promise<void>;
  volume: number;
}

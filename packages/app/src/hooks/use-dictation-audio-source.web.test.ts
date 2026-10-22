/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/desktop/host", () => ({ isElectronRuntime: () => true }));

import { useDictationAudioSource } from "./use-dictation-audio-source.web";

interface FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  connect: () => void;
  disconnect: () => void;
}

let processor: FakeProcessor;

function deliver(samples: number): void {
  const input = new Float32Array(samples).fill(0.25);
  processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } });
}

function decodedSamples(base64: string): number {
  return atob(base64).length / 2;
}

beforeEach(() => {
  vi.useFakeTimers();
  processor = { onaudioprocess: null, connect: () => undefined, disconnect: () => undefined };
  class FakeAudioContext {
    sampleRate = 16000;
    destination = {};
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createScriptProcessor() {
      return processor;
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => undefined }] }),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps capturing for the stop tail so the last word is sent", async () => {
  const segments: string[] = [];
  const { result } = renderHook(() =>
    useDictationAudioSource({ onPcmSegment: (pcm) => segments.push(pcm) }),
  );

  await act(() => result.current.start());
  deliver(4096);

  let stopped = false;
  let stopPromise: Promise<void> = Promise.resolve();
  act(() => {
    stopPromise = result.current.stop({ tailMs: 400 }).then(() => {
      stopped = true;
      return undefined;
    });
  });
  // Audio that was still in the device pipeline when the user stopped.
  deliver(4096);
  expect(stopped).toBe(false);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    await stopPromise;
  });

  const total = segments.reduce((sum, segment) => sum + decodedSamples(segment), 0);
  expect(total).toBe(8192);
});

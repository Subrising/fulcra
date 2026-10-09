/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DICTATION_STOP_TAIL_MS } from "./use-dictation.shared";
import { useDictation } from "./use-dictation";

// Stands in for the phone: the microphone delivers audio until it is stopped, then drops what is still in flight, as
// the native capture does. The on-device recognizer returns every word it was given.
const phone = vi.hoisted(() => ({
  onPcmSegment: null as ((audio: string) => void) | null,
  capturing: false,
  heard: [] as string[],
}));

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: { onPcmSegment: (audio: string) => void }) => {
    phone.onPcmSegment = config.onPcmSegment;
    return {
      volume: 0,
      start: async () => {
        phone.capturing = true;
      },
      stop: async () => {
        phone.capturing = false;
      },
    };
  },
}));
vi.mock("@/dictation/on-device-dictation", () => ({
  createOnDeviceDictation: () => ({
    start: async () => true,
    append: (audio: string) => phone.heard.push(audio),
    finish: async () => phone.heard.join(" "),
    cancel: () => undefined,
  }),
}));

function speak(words: string) {
  if (phone.capturing) phone.onPcmSegment?.(words);
}

beforeEach(() => {
  vi.useFakeTimers();
  phone.onPcmSegment = null;
  phone.capturing = false;
  phone.heard = [];
});
afterEach(() => {
  vi.useRealTimers();
});

it("keeps the last words said as the person taps stop", async () => {
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation({ client: null, onTranscript }));
  await act(() => result.current.startDictation());
  speak("please send the report");

  let confirmed!: Promise<void>;
  act(() => {
    confirmed = result.current.confirmDictation();
  });
  // The last word lands 200 ms after the tap: still being said, or still in the audio pipeline.
  await act(() => vi.advanceTimersByTimeAsync(200));
  speak("today");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DICTATION_STOP_TAIL_MS);
    await confirmed;
  });

  expect(onTranscript).toHaveBeenCalledTimes(1);
  expect(onTranscript.mock.calls[0]?.[0]).toBe("please send the report today");
});

it("cancelling during the stop tail sends nothing", async () => {
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation({ client: null, onTranscript }));
  await act(() => result.current.startDictation());
  speak("never mind");

  let confirmed!: Promise<void>;
  act(() => {
    confirmed = result.current.confirmDictation();
  });
  await act(async () => {
    await result.current.cancelDictation();
    await vi.advanceTimersByTimeAsync(DICTATION_STOP_TAIL_MS);
    await confirmed;
  });

  expect(onTranscript).not.toHaveBeenCalled();
});

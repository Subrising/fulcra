import React, { act, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import {
  useQuery,
  useQueries,
  useOperationPause,
} from "../../../../control/orca-organization/client/read-on-open";

it.each(["single", "multiple"] as const)(
  "%s queries read on open and refresh, then stop on close",
  async (kind) => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const read = vi.fn(async () => "Observed");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Single() {
      const result = useQuery({
        queryKey: [kind],
        queryFn: read,
        staleTime: Infinity,
        refetchInterval: 1000,
      });
      const refetch = result.refetch;
      const refresh = useCallback(() => void refetch(), [refetch]);
      return (
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      );
    }
    function Multiple() {
      const results = useQueries({
        queries: [{ queryKey: [kind], queryFn: read, staleTime: Infinity, refetchInterval: 1000 }],
      });
      const refetch = results[0].refetch;
      const refresh = useCallback(() => void refetch(), [refetch]);
      return (
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      );
    }
    const View = kind === "single" ? Single : Multiple;
    const open = () =>
      act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <View />
          </QueryClientProvider>,
        );
      });
    try {
      await open();
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(read).toHaveBeenCalledTimes(1);
      await act(async () => {
        container.querySelector("button")!.click();
      });
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => {
        root.render(null);
      });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(read).toHaveBeenCalledTimes(2);
      await open();
      expect(read).toHaveBeenCalledTimes(3);
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
      container.remove();
      vi.useRealTimers();
    }
  },
);

it.each([1000, 1500])("cancels operation status waits on close (%s ms)", async (milliseconds) => {
  vi.useFakeTimers();
  const read = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let pending: Promise<unknown> | undefined;
  function Waiting() {
    const pause = useOperationPause(milliseconds);
    useEffect(() => {
      pending = pause().then(read, () => undefined);
    }, [pause]);
    return null;
  }
  try {
    await act(async () => root.render(<Waiting />));
    await act(async () => root.render(null));
    await pending;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(read).not.toHaveBeenCalled();
    await act(async () => root.render(<Waiting />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});

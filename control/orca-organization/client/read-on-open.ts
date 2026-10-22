import { useCallback, useEffect, useRef } from "react";
import {
  useQuery as useReactQuery,
  useQueries as useReactQueries,
  type QueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";

export { skipToken, useQueryClient } from "@tanstack/react-query";

// Read when a view opens or the user refreshes. Focus and reconnect do not start reads.
export const READ_ON_OPEN = {
  refetchInterval: false,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

export function readOnOpen<T extends object>(options: T) {
  return { ...options, ...READ_ON_OPEN };
}

// These wrappers preserve each hook's data and overloads. Only read scheduling changes.
export const useQuery = ((...args: Parameters<typeof useReactQuery>) =>
  useReactQuery(readOnOpen(args[0]), args[1])) as typeof useReactQuery;

export const useQueries = ((
  options: { queries: readonly UseQueryOptions[] },
  client?: QueryClient,
) =>
  useReactQueries(
    { ...options, queries: options.queries.map(readOnOpen) },
    client,
  )) as typeof useReactQueries;

// Explicit operations can wait for their result while open. Closing the view cancels the next status read.
export function useOperationPause(milliseconds: number) {
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  return useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        const signal = lifetime.current?.signal;
        if (!signal || signal.aborted) {
          reject(new Error("View closed"));
          return;
        }
        const cancel = () => {
          clearTimeout(timer);
          reject(new Error("View closed"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, milliseconds);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    [milliseconds],
  );
}

import { useEffect, useRef, useState } from "react";

export type ContextObservation<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; data: T };

// Local rows never enter a shared query cache. Scope/admission changes hide old rows
// synchronously; cleanup and current-generation checks fence late async results.
export function useContextObservation<T>(
  key: string,
  enabled: boolean,
  observe: (publish: (value: T) => void, fail: () => void) => () => void,
): ContextObservation<T> {
  const [result, setResult] = useState<{
    key: string;
    generation: number;
    value: ContextObservation<T>;
  }>();
  const generation = useRef(0);
  const identity = useRef({ key, enabled, observe });
  if (
    identity.current.key !== key ||
    identity.current.enabled !== enabled ||
    identity.current.observe !== observe
  ) {
    identity.current = { key, enabled, observe };
    generation.current += 1;
  }
  const currentGeneration = generation.current;
  useEffect(() => {
    if (!enabled) {
      setResult(undefined);
      return;
    }
    let cancelled = false;
    const commit = (value: ContextObservation<T>) => {
      if (!cancelled && generation.current === currentGeneration) {
        setResult({ key, generation: currentGeneration, value });
      }
    };
    const stop = observe(
      (data) => commit({ status: "loaded", data }),
      () => commit({ status: "error" }),
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [currentGeneration, enabled, key, observe]);
  return enabled && result?.key === key && result.generation === currentGeneration
    ? result.value
    : { status: "loading" };
}

import type { GhRunner } from "./connector.mjs";
import type { TrackerFailure } from "./http.mjs";
export function classifyGhError(error: unknown): TrackerFailure;
export function ghEnvironment(env?: Record<string, string | undefined>): Record<string, string>;
export function createGhRunner(options?: {
  binary?: string;
  run?: unknown;
  assert?: (args: string[]) => string[];
}): GhRunner;

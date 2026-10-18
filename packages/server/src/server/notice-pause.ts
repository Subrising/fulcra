import { readFileSync } from "node:fs";
import { z } from "zod";

const PausePolicy = z.object({
  pausedProviders: z.array(z.string()).default([]),
  exceptSessions: z.array(z.string()).default([]),
});

/** A malformed policy fails closed. Only a missing file means that no pause was set. */
export function noticePaused(
  file: string,
  target: { id: string; provider: string; labels?: Record<string, string> } | null | undefined,
  readAncestor?: (id: string) => { id: string; labels?: Record<string, string> } | null | undefined,
): boolean {
  if (!target) return false;
  try {
    const policy = PausePolicy.parse(JSON.parse(readFileSync(file, "utf8")));
    if (!policy.pausedProviders.includes(target.provider.split("/")[0]!)) return false;
    return !hasExceptedAncestor(target, policy.exceptSessions, readAncestor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Invalid notice pause policy. Delivery is held.", { cause: error });
  }
}

interface PauseTarget {
  id: string;
  labels?: Record<string, string>;
}
function hasExceptedAncestor(
  target: PauseTarget,
  exceptions: string[],
  readAncestor?: (id: string) => PauseTarget | null | undefined,
): boolean {
  const seen = new Set<string>();
  const cache = new Map<string, ReturnType<NonNullable<typeof readAncestor>>>();
  let current: { id: string; labels?: Record<string, string> } | null | undefined = target;
  try {
    while (current && !seen.has(current.id) && seen.size < 128) {
      if (exceptions.includes(current.id)) return true;
      seen.add(current.id);
      if (!current.labels || typeof current.labels !== "object") return false;
      const parent: string | undefined =
        current.labels["paseo.parent-agent-id"] ?? current.labels.parent;
      if (parent === undefined) return false;
      if (typeof parent !== "string" || !parent.trim() || !readAncestor) return false;
      if (exceptions.includes(parent)) return true;
      if (!cache.has(parent)) cache.set(parent, readAncestor(parent));
      current = cache.get(parent);
      if (current?.id !== parent) return false;
    }
  } catch {
    return false;
  }
  return false;
}

export class NoticePausedError extends Error {
  constructor() {
    super("Provider paused before notice handoff");
  }
}

/** Directory events can omit the filename. Compare policy content before scheduling another drain. */
export function noticePauseVersion(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

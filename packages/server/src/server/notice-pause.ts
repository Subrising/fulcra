import { readFileSync } from "node:fs";
import { z } from "zod";

const PausePolicy = z.object({
  pausedProviders: z.array(z.string()).default([]),
  exceptSessions: z.array(z.string()).default([]),
});

/** A malformed policy fails closed. Only a missing file means that no pause was set. */
export function noticePaused(
  file: string,
  target: { id: string; provider: string } | null | undefined,
): boolean {
  if (!target) return false;
  try {
    const policy = PausePolicy.parse(JSON.parse(readFileSync(file, "utf8")));
    return (
      policy.pausedProviders.includes(target.provider.split("/")[0]!) &&
      !policy.exceptSessions.includes(target.id)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Invalid notice pause policy. Delivery is held.", { cause: error });
  }
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

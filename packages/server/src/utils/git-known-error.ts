import { isGitChildLimitError } from "@getpaseo/plugin/server/git";

/** Errors that git already explains. They need one warning line and no stack trace. */
export function isKnownGitRefusal(error: unknown): boolean {
  if (isGitChildLimitError(error)) return true;
  return (
    error instanceof Error &&
    /git fetch is paused after a failure|git fetch requires credentials|not a git repository/i.test(
      error.message,
    )
  );
}

/** Log fields: the message only for a known refusal, the full error (with stack) for the rest. */
export function gitFailureLogFields<T extends object>(
  error: unknown,
  fields: T,
): T & ({ err: unknown } | { reason: string }) {
  if (isKnownGitRefusal(error)) {
    return { ...fields, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ...fields, err: error };
}

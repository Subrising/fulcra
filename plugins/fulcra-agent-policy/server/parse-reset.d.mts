export declare function parseLimitReset(input: {
  text: string;
  now: number;
  retryAfterSeconds?: number | null;
  /** The host's own zone, used when the message names a clock time without one. */
  zone?: string;
}): number | null;
/** Conservative wait when the provider gave no reset time: 15, then 30, then 60 minutes, capped at an hour. */
export declare function backoffMs(attempt: number): number;

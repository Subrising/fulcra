export declare const UUID: RegExp;
export declare const HEALTH: readonly ["on-track", "at-risk", "blocked", "idle"];
export declare const SEVERITY: readonly ["low", "medium", "high"];
export declare const BRIEF_LIMITS: Readonly<{ headline: number; now: number; items: number; itemText: number; mitigation: number; evidence: number; evidenceLabel: number }>;
export declare const AUTHORED_FIELDS: readonly string[];
export declare const STALE_AGE_MS: number;
export declare const STALE_ACTIVITY_MS: number;
export declare class BriefRefused extends Error {}
export type BriefWarning = { field: string; found: string[] };
export declare function validateBrief(input: unknown): { brief: Record<string, unknown>; warnings: BriefWarning[] };
export declare function briefStale(a: { writtenAt: string | number | null; lastActivityAt?: string | number | null; now?: string | number }): boolean;

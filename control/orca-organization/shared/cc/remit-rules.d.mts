export declare const KEY: RegExp;
export declare const UUID: RegExp;
export declare const REMIT_STATES: readonly ["active", "ended"];
export declare const REMIT_ACTIONS: readonly ["assigned", "moved", "ended", "domain-set"];
export declare const REMIT_LIMITS: Readonly<{ noteMin: number; note: number; label: number }>;
export declare class RemitRefused extends Error {}
export type RemitScope = { kind: "project"; projectId: string } | { kind: "domain"; domain: string; label: string };
export type Owner = { kind: "project" | "domain"; primeSeat: string; remitId: string } | { kind: "unassigned"; primeSeat: null; remitId: null };
export declare function remitNote(note: unknown): string;
export declare function remitScope(scope: unknown): RemitScope;
export declare function scopeKey(scope: RemitScope): string;
export declare function resolveOwner(projectId: string, remits: readonly { id: string; primeSeat: string; state: string; scope: RemitScope }[], domains: ReadonlyMap<string, string | null>): Owner;

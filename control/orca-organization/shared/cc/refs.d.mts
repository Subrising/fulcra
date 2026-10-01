// Types for refs.mjs, the one implementation of CONTRACTS v1.9 §2.1, §1a and §3.2 #9.
export type RefKind = "project" | "task" | "session" | "seat" | "turn" | "repo" | "commit" | "pr" | "issue" | "file" | "decision" | "brief" | "env" | "deploy" | "promotion" | "archmap" | "outcome";
export type ParsedRef =
  | { kind: "turn"; sessionId: string; turnId: string }
  | { kind: "repo"; repoKey: string }
  | { kind: "commit"; repoKey: string; sha: string }
  | { kind: "pr"; repoKey: string; number: number }
  | { kind: "issue"; connector: string; site: string | null; remoteId: string; ref: string }
  | { kind: "file"; repoKey: string; path: string }
  | { kind: "brief"; projectId: string; revision: number }
  | { kind: "archmap"; repoKey: string; sha: string; mapName: string }
  | { kind: "seat"; seat: string }
  | { kind: "project" | "task" | "session" | "decision" | "env" | "deploy" | "promotion" | "outcome"; id: string };
export declare const REF_PATTERNS: Readonly<Record<RefKind, RegExp>>;
export declare const REF_KINDS: readonly RefKind[];
export declare const REF_MAX: number;
export declare function parseRef(ref: unknown): ParsedRef | null;
export declare function isRef(ref: unknown): boolean;
export declare const PERSONAL_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[];
export declare function personalMatch(text: unknown): string | null;
export declare function noPersonal(text: unknown): boolean;
export declare const JARGON: readonly string[];
export declare function plainLanguageCheck(text: unknown): string[];
export declare function sentenceCount(text: unknown): number;

export declare const KEY: RegExp;
export declare const UUID: RegExp;
export declare const SHA256: RegExp;
export declare const KINDS: readonly ["decision", "approval", "question"];
export declare const STATES: readonly ["open", "chosen", "withdrawn", "superseded", "expired"];
export declare const REVERSIBILITY: readonly [
  "reversible",
  "reversible-with-effort",
  "irreversible",
];
export declare const CONFIDENCE: readonly ["low", "medium", "high"];
export declare const APP_VIA: readonly [
  "app-mac",
  "app-ios",
  "app-android",
  "app-windows",
  "app-linux",
  "app-web",
];
export declare const VIA: readonly [
  "app-mac",
  "app-ios",
  "app-android",
  "app-windows",
  "app-linux",
  "app-web",
  "discord-openclaw",
  "session",
  "cli",
];
export declare const LIMITS: Readonly<
  Record<
    | "title"
    | "situation"
    | "optionTitle"
    | "optionSummary"
    | "example"
    | "benefit"
    | "cost"
    | "time"
    | "risk"
    | "why"
    | "wouldChangeIf"
    | "evidence"
    | "evidenceLabel"
    | "note"
    | "options"
    | "situationSentences"
    | "summarySentences",
    number
  >
>;
export declare const FREE_TEXT_OPTION: "answer";
export declare const ASK_FIELDS: readonly string[];
export declare class PacketRefused extends Error {}
export declare function validateAsk(
  input: unknown,
  options?: { atAsk?: boolean },
): { packet: Record<string, unknown>; warnings: string[] };
export declare function plainLanguageFindings(packet: unknown): string[];
export declare function canonicalJson(value: unknown): string;
export declare function actionTarget(action: { type: string; [k: string]: unknown }): string | null;

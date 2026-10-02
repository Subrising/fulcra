// CONTRACTS v1.9 §2.1: there is exactly one implementation, refs.mjs (plain JavaScript, shared with the controller).
// This file only re-exports it for the plugin, plus the zod `ref`.
import { z } from "zod";
import { REF_MAX, isRef } from "./refs.mjs";
export {
  REF_PATTERNS,
  REF_KINDS,
  REF_MAX,
  parseRef,
  isRef,
  personalMatch,
  PERSONAL_PATTERNS,
  noPersonal,
  JARGON,
  plainLanguageCheck,
  sentenceCount,
} from "./refs.mjs";
export type { RefKind, ParsedRef } from "./refs.mjs";
/** The contract's `ref`: z.string().max(300) that parses as exactly one kind. */
export const ref = z
  .string()
  .max(REF_MAX)
  .refine((value) => isRef(value), { message: "Not a valid ref" });

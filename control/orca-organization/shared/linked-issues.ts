import { z } from "zod";

/**
 * Linked issues on the work map — the contract J3 (issue trackers) fills.
 *
 * J2 consumes, J3 supplies. A provider runs in the plugin server, never in the renderer, so a
 * tracker token can never reach the app; the wire shape below carries no credential field at all,
 * and `.strict()` rejects any a provider might add.
 *
 * Unavailable is not empty: a provider that could not answer says `available: false` and the map
 * renders "Issues unavailable from <source>", never "no issues".
 */

const id = z.string().uuid();

export const ISSUE_SCOPES = ["project", "workstream", "session"] as const;
export const ISSUE_STATES = ["open", "in_progress", "blocked", "done", "cancelled", "unknown"] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const issueRef = z.object({
  scope: z.enum(ISSUE_SCOPES),
  scopeId: id,
}).strict();
export type IssueRef = z.infer<typeof issueRef>;

export const issueSource = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** https only. Shown as selectable text; the map never fetches or opens it. */
export const issueUrl = z.string().max(512).url().refine(value => value.startsWith("https://"), "https only");

export const linkedIssue = z.object({
  source: issueSource,
  key: z.string().min(1).max(64),
  title: z.string().max(160),
  state: z.enum(ISSUE_STATES),
  rawState: z.string().max(64).nullable(),
  /** A display name or handle. Never an email address. */
  assignee: z.string().max(64).refine(value => !value.includes("@"), "handle only").nullable(),
  url: issueUrl.nullable(),
  updatedAt: z.string().datetime().nullable(),
  linkedTo: issueRef,
  /** `is`: the workstream's own board issue. `links`: an external reference to it. */
  relation: z.enum(["is", "links"]),
}).strict();
export type LinkedIssue = z.infer<typeof linkedIssue>;

export const issueProviderStatus = z.object({
  source: issueSource,
  available: z.boolean(),
  note: z.string().max(512),
}).strict();

export const linkedIssuesResult = z.object({
  observedAt: z.string().datetime(),
  providers: z.array(issueProviderStatus).max(8),
  issues: z.array(linkedIssue).max(256),
  truncated: z.boolean(),
}).strict();
export type LinkedIssuesResult = z.infer<typeof linkedIssuesResult>;

/**
 * Server-side provider interface (not an RPC). A provider must be read-only, must finish within
 * the signal's deadline, and must not throw: it reports `available: false` with a note instead.
 * J2 enforces the deadline and the bounds regardless, and drops any row that fails `linkedIssue`.
 */
export interface LinkedIssueProvider {
  source: string;
  resolve(refs: IssueRef[], signal: AbortSignal): Promise<{ available: boolean; note: string; issues: unknown[] }>;
}

/** Board wording varies by tracker; anything unrecognised is `unknown`, never a concrete state. */
export function normalizeIssueState(raw: unknown): IssueState {
  const value = typeof raw === "string" ? raw.toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["todo", "backlog", "open", "new", "to_do"].includes(value)) return "open";
  if (["in_progress", "in_review", "started", "doing", "active"].includes(value)) return "in_progress";
  if (["blocked", "on_hold"].includes(value)) return "blocked";
  if (["done", "closed", "completed", "resolved", "merged"].includes(value)) return "done";
  if (["cancelled", "canceled", "wont_do", "duplicate"].includes(value)) return "cancelled";
  return "unknown";
}

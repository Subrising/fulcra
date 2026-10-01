// CONTRACTS.md §7: connector descriptor and item (§7.1), account (§7.2, as the host returns it), mapping
// (§7.3; accountId null = the GitHub command-line login, CONTRACT-CHANGE-J4-1), plus the J4 RPCs:
// organization.integrations and organization.tracker-mappings.* (which replace organization.trackers.* at
// C2) and organization.tracker-view (a project's items with their "worked by" trails). The rules are the
// controller's own (connector-rules.mjs), so the plugin and the controller cannot disagree.
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { ref } from "./refs";
import { noPersonal } from "./refs.mjs";
import { CONNECTOR_ID, AUTH_METHODS, ITEM_KINDS, ITEM_STATES, MAPPING_STATES, HOSTNAME, itemProblem } from "./connector-rules.mjs";
import { link } from "./links";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
const words = (max: number) => z.string().max(max).refine(noPersonal, { message: "Contains personal or host-specific data" });
const https = z.string().max(512).refine(v => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } }, { message: "Not an https URL" });
export const connectorId = z.string().regex(CONNECTOR_ID);
export const site = z.string().max(253).regex(HOSTNAME);
const observation = { version: z.literal(1), observedAt: at, partial: z.boolean() };
export const tokenHelp = z.object({ createUrl: https, scopes: z.array(z.string().min(1).max(60)).max(12), note: words(300) }).strict();
// §7.1 without the operations: what a screen may know about a connector.
export const connectorDescriptor = z.object({
  id: connectorId, label: z.string().min(1).max(40), kinds: z.array(tuple(ITEM_KINDS as unknown as readonly ["issue", "ticket", "pr"])).min(1).max(3),
  selfHosted: z.boolean(), auth: z.array(tuple(AUTH_METHODS as unknown as readonly ["browser", "device", "token", "cli"])).max(3),
  tokenHelp, keyPatterns: z.array(z.string().max(120)).max(4), sync: z.object({ pollSeconds: z.number().int().min(60).max(3600), webhook: z.literal(false) }).strict(),
}).strict();
export const trackerItem = z.object({
  key: ref, connector: connectorId, kind: tuple(ITEM_KINDS as unknown as readonly ["issue", "ticket", "pr"]), ref: z.string().min(1).max(40), title: z.string().max(256),
  state: tuple(ITEM_STATES as unknown as readonly ["open", "in-progress", "closed", "merged", "unknown"]), url: https, updatedAt: at,
  assignee: z.string().max(80).nullable(), labels: z.array(z.string().max(50)).max(8),
}).strict().refine(it => itemProblem(it) === null, { message: "Not a valid tracker item" });
// §7.2 exactly. displayName is the provider's own name: shown in the app only, never published (§7.2 v1.4).
export const account = z.object({
  version: z.literal(1), id, connector: connectorId, site: site.nullable(), displayName: z.string().min(1).max(80),
  method: tuple(AUTH_METHODS as unknown as readonly ["browser", "device", "token", "cli"]), scopes: z.array(z.string().max(60)).max(12),
  state: z.enum(["connected", "expired", "needs-reconnect", "revoked"]), expiresAt: at.nullable(), lastCheckedAt: at, createdAt: at,
}).strict();
export const mapping = z.object({
  id, revision: z.number().int().min(1), projectId: id, connector: connectorId, accountId: id.nullable(), remoteId: z.string().min(1).max(64),
  remoteName: z.string().min(1).max(200), site: site.nullable(), state: tuple(MAPPING_STATES as unknown as readonly ["mapped", "unmapped"]), note: z.string().max(500), at,
}).strict();
const outcome = { ok: z.boolean(), message: z.string().max(300).nullable() };

export const integrationsRpc = defineContract({
  name: "organization.integrations", input: z.object({}).strict(),
  // hostApi false: this Fulcra host predates the shared credential store (P1); the screen says so.
  output: z.object({ ...observation, hostApi: z.boolean(), connectors: z.array(connectorDescriptor).max(16), accounts: z.array(account).max(64) }).strict(),
});
export const trackerMappingsRpc = defineContract({
  name: "organization.tracker-mappings", input: z.object({ projectId: id }).strict(),
  output: z.object({ ...observation, mappings: z.array(mapping).max(32),
    // J3's one-tracker-per-project set-up, until it is copied (then `copied` is true).
    legacy: z.object({ connector: connectorId, remoteName: z.string().max(200), commandLine: z.boolean(), copied: z.boolean() }).strict().nullable() }).strict(),
});
const target = { connector: connectorId, accountId: id.nullable(), remoteName: z.string().min(1).max(200), site: site.nullable() };
// The operator's check before anything is recorded: what the tracker says this name is.
export const trackerMappingResolveRpc = defineContract({
  name: "organization.tracker-mappings.resolve", input: z.object(target).strict(),
  output: z.object({ ...outcome, remote: z.object({ remoteId: z.string().max(64), remoteName: z.string().max(200), site: site.nullable() }).strict().nullable() }).strict(),
});
// confirmRemoteId is the id the operator saw; the server resolves again and refuses if it changed.
export const trackerMappingMapRpc = defineContract({
  name: "organization.tracker-mappings.map",
  input: z.object({ messageId: id, projectId: id, ...target, confirmRemoteId: z.string().min(1).max(64), expectedRevision: z.number().int().min(0), note: words(500) }).strict(),
  output: z.object({ ...outcome, mapping: mapping.nullable() }).strict(),
});
export const trackerMappingUnmapRpc = defineContract({
  name: "organization.tracker-mappings.unmap",
  input: z.object({ messageId: id, id, expectedRevision: z.number().int().min(1), note: words(500) }).strict(),
  output: z.object({ ...outcome, mapping: mapping.nullable() }).strict(),
});
export const TRACKER_STATUS = ["ok", "stale", "auth-required", "expired", "forbidden", "rate-limited", "offline", "not-found", "invalid-response", "needs-host-update", "error"] as const;
// One step of a "worked by" trail: "#42 → fixed in PR #17 → by session 'J4 Tracking' → merged 13:10".
export const trailStep = z.object({
  kind: z.enum(["pr", "session", "task", "state"]), ref: ref.nullable(), label: z.string().max(120), at: at.nullable(),
  provenance: z.enum(["manual", "reported", "inferred"]).nullable(), confidence: z.enum(["high", "medium", "low"]).nullable(),
}).strict();
export const trackerViewRpc = defineContract({
  name: "organization.tracker-view", input: z.object({ projectId: id }).strict(),
  output: z.object({
    ...observation,
    trackers: z.array(z.object({ mappingId: id, connector: connectorId, label: z.string().max(40), remoteName: z.string().max(200), commandLine: z.boolean(),
      status: z.enum(TRACKER_STATUS), retryAt: at.nullable(), observedAt: at.nullable() }).strict()).max(32),
    items: z.array(z.object({ item: trackerItem, stale: z.boolean(), observedAt: at, links: z.array(link).max(16), trail: z.array(trailStep).max(8) }).strict()).max(200),
  }).strict(),
});
// L36: the only path that fetches and stores tracker items (a write: it records what the tracker returned). The views
// call it on open and every few minutes; trackerViewRpc stays a read of what is stored.
export const trackerRefreshRpc = defineContract({ name: "organization.tracker-refresh", input: z.object({ projectId: id }).strict(), output: trackerViewRpc.output });
export type TrackerView = z.infer<typeof trackerViewRpc.output>;
export type Integrations = z.infer<typeof integrationsRpc.output>;

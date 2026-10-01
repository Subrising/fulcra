import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { pluginRegistry } from "@/plugins/registry";
import { needsDirectConnection } from "@/plugins/command-centre-connection";
import {
  SESSION_OWNERSHIP_RPC,
  type SessionOwnershipRequest,
  type SessionOwnershipResponse,
} from "@getpaseo/protocol/session-ownership";
import {
  selectSessionOwnership,
  UNASSIGNED_SESSION_OWNERSHIP,
  type SessionOwnership,
  type SessionOwnershipRecord,
} from "./session-ownership";

const ORGANIZATION_PLUGIN_ID = "orca-organization";
/**
 * A directory plugin's id is chosen when it is installed (`--id`), not fixed by its
 * manifest, and the staging procedure deliberately registers a second build alongside the
 * live one as `orca-organization-next`. The catalog exposes only ids and client bundles —
 * there is no way to ask which plugin contributes an RPC — so the id is the only handle
 * the app has, and assuming exactly one was wrong.
 */
const ORGANIZATION_PLUGIN_PREFIX = `${ORGANIZATION_PLUGIN_ID}-`;
/** One call per host per tick, so a list of rows costs one request rather than one each. */
const BATCH_DELAY_MS = 30;
/** A refusing controller must cost one failure, not a loop. */
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * How long a successful answer may still be shown. Ownership changes without telling the
 * app — an operator adopts a session, a project is reassigned — and there is no event on
 * this side that says so, so a cached answer genuinely becomes less trustworthy with age.
 * Past this, the claim is dropped rather than annotated: the row falls back to the derived
 * placement it showed before any record arrived, and asks again the next time it renders.
 */
const POSITIVE_TTL_MS = 2 * 60 * 1000;
const MAX_IDS_PER_CALL = 100;

interface CachedOwnership {
  ownership: SessionOwnership;
  fetchedAt: number;
}

interface HostState {
  ownership: Map<string, CachedOwnership>;
  /** Queued or awaiting a response. Not a record of having asked once. */
  inFlight: Set<string>;
  queued: Set<string>;
  flushHandle: ReturnType<typeof setTimeout> | null;
  quietUntil: number;
  loggedFailure: boolean;
  loggedResolution: boolean;
}

const hosts = new Map<string, HostState>();
const listeners = new Set<() => void>();

function hostState(serverId: string): HostState {
  let state = hosts.get(serverId);
  if (!state) {
    state = {
      ownership: new Map(),
      inFlight: new Set(),
      queued: new Set(),
      flushHandle: null,
      quietUntil: 0,
      loggedFailure: false,
      loggedResolution: false,
    };
    hosts.set(serverId, state);
  }
  return state;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Which installed plugin to ask. The exact id wins when it is present; otherwise a single
 * family member is used, so a host running only a staged build still answers. Several
 * family members with no exact match is ambiguous, and guessing there would silently pick
 * whose ownership records a person is reading — so it picks none and says so once.
 */
export function resolveOrganizationPluginId(serverId: string): string | null {
  const installed = pluginRegistry
    .getSnapshot()
    .filter((plugin) => plugin.serverId === serverId)
    .map((plugin) => plugin.id);
  if (installed.includes(ORGANIZATION_PLUGIN_ID)) return ORGANIZATION_PLUGIN_ID;
  const family = installed.filter((id) => id.startsWith(ORGANIZATION_PLUGIN_PREFIX));
  if (family.length === 1) return family[0];
  logUnresolvedPluginId(serverId, family);
  return null;
}

/**
 * Nothing was asked, so no failure will ever be logged — which used to make this branch
 * indistinguishable from "the call left the app and something else went wrong". Silence
 * has to mean one thing, so the two ways of resolving nothing each say so once.
 *
 * Waits for the catalog to settle: plugins arrive asynchronously after a host connects,
 * and announcing "not installed" during that window would be a false diagnosis.
 */
function logUnresolvedPluginId(serverId: string, family: string[]): void {
  const state = hostState(serverId);
  if (state.loggedResolution || !pluginRegistry.isCatalogSettled(serverId)) return;
  state.loggedResolution = true;
  if (family.length === 0) {
    console.info(
      `[session-ownership] ${serverId}: no organization plugin is installed, so ownership is not available on this host. Rows keep their derived placement.`,
    );
    return;
  }
  console.warn(
    `[session-ownership] ${serverId}: several organization plugins are installed (${family.join(", ")}) and none has the exact id '${ORGANIZATION_PLUGIN_ID}'. Refusing to choose whose ownership records to read, so nothing is asked.`,
  );
}

/**
 * A payload shape this app does not understand is its own failure, distinct from a
 * refusal. Diagnosing it as "refused" would send someone to the controller for a fault
 * that lives in the seam — the precise misdiagnosis the failure log exists to prevent.
 */
class MalformedOwnershipResponse extends Error {
  constructor() {
    super("Malformed ownership response");
    this.name = "MalformedOwnershipResponse";
  }
}

/**
 * A record is anything object-shaped; `selectSessionOwnership` judges its contents.
 *
 * The response key is read through the declared `SessionOwnershipResponse` rather than an
 * inline cast, so renaming it in the shared module breaks this line at compile time
 * instead of turning into a runtime shape mismatch that reads as a refusal.
 */
function readRecordMap(response: unknown): Map<string, SessionOwnershipRecord | null> | null {
  if (typeof response !== "object" || response === null) return null;
  const { ownership } = response as Partial<SessionOwnershipResponse>;
  if (typeof ownership !== "object" || ownership === null) return null;
  const records = new Map<string, SessionOwnershipRecord | null>();
  for (const [agentId, value] of Object.entries(ownership as Record<string, unknown>)) {
    if (value === null || value === undefined) {
      records.set(agentId, null);
      continue;
    }
    // A non-object where a record belongs is a broken response, not an unresolvable
    // record: treat it as absent rather than claiming the controller said "unknown".
    records.set(agentId, typeof value === "object" ? (value as SessionOwnershipRecord) : null);
  }
  return records;
}

function diagnoseOwnershipReadFailure(message: string): string {
  if (message.includes("does not contribute RPC"))
    return `the plugin does not register '${SESSION_OWNERSHIP_RPC}' — this is a wiring fault on one side of the seam, not a refusal`;
  if (message.includes("Plugin is not available"))
    return "the organization plugin is not running on this host";
  return "the read was refused or the controller is unavailable — expected before activation";
}

/**
 * A refusing controller and a method the plugin never registered fail identically at the
 * call site, and the row renders unassigned either way — by design, and correctly. That
 * makes a wiring fault invisible in the interface, so the one signal that distinguishes
 * them belongs in the log instead. Once per host, never repeated, never surfaced in the UI.
 */
function logFirstFailure(serverId: string, error: unknown): void {
  if (error instanceof MalformedOwnershipResponse) {
    console.warn(
      `[session-ownership] ${serverId}: the plugin answered in a shape this app does not understand — the two sides have diverged on the payload, not a refusal. Rows stay unassigned.`,
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const diagnosis = diagnoseOwnershipReadFailure(message);
  console.warn(`[session-ownership] ${serverId}: ${diagnosis}. Rows stay unassigned.`);
}

async function flush(serverId: string): Promise<void> {
  const state = hostState(serverId);
  state.flushHandle = null;
  const ids = [...state.queued].slice(0, MAX_IDS_PER_CALL);
  if (ids.length === 0) return;
  for (const id of ids) state.queued.delete(id);
  const pluginId = resolveOrganizationPluginId(serverId);
  const client = pluginId ? getHostRuntimeStore().getClient(serverId) : null;
  // L46: a relay-only host cannot answer Command Centre reads; treat it like a disconnected one.
  const relayOnly =
    pluginId !== null &&
    needsDirectConnection(
      pluginId,
      getHostRuntimeStore().getSnapshot(serverId)?.activeConnection,
      client,
    );
  if (!client || !pluginId || relayOnly) {
    // Disconnected host: forget the request so it is retried when rows render again,
    // rather than being remembered as answered.
    for (const id of ids) state.inFlight.delete(id);
    return;
  }
  try {
    // Typed against the shared declaration so the request keys are checked rather than
    // spelled twice from memory.
    const request: SessionOwnershipRequest = { agentIds: ids };
    const response = await client.invokePluginRpc(pluginId, SESSION_OWNERSHIP_RPC, request);
    const records = readRecordMap(response);
    if (!records) throw new MalformedOwnershipResponse();
    const fetchedAt = Date.now();
    for (const id of ids) {
      state.ownership.set(id, {
        ownership: selectSessionOwnership(records.get(id) ?? null),
        fetchedAt,
      });
      state.inFlight.delete(id);
    }
    notify();
  } catch (error) {
    if (!state.loggedFailure) {
      state.loggedFailure = true;
      logFirstFailure(serverId, error);
    }
    // Refused, unsupported, or unreachable. The controller refuses every ownership read
    // until activation, so this is the expected path today: go quiet for a while and
    // report nothing rather than retrying, spinning, or inventing a state. No error text
    // is surfaced — an ownership read failing is not something a person can act on from
    // a session row.
    state.quietUntil = Date.now() + FAILURE_COOLDOWN_MS;
    for (const id of ids) state.inFlight.delete(id);
  }
  if (state.queued.size > 0) schedule(serverId);
}

function schedule(serverId: string): void {
  const state = hostState(serverId);
  if (state.flushHandle !== null) return;
  state.flushHandle = setTimeout(() => {
    void flush(serverId);
  }, BATCH_DELAY_MS);
}

/**
 * Ask for one session's owner. Only rows that actually render call this, which is what
 * bounds the request to what is on screen. Asking twice for the same session costs
 * nothing, and a host that has no organization plugin costs no request at all.
 */
function isFresh(entry: CachedOwnership | undefined, now: number): entry is CachedOwnership {
  return entry !== undefined && now - entry.fetchedAt < POSITIVE_TTL_MS;
}

export function requestSessionOwnership(serverId: string, agentId: string): void {
  if (!serverId || !agentId) return;
  const state = hostState(serverId);
  const now = Date.now();
  // A fresh answer needs nothing. An expired one is re-asked here — on the render that
  // wanted it — rather than on a timer, so a row nobody is looking at costs nothing.
  if (isFresh(state.ownership.get(agentId), now) || state.inFlight.has(agentId)) return;
  if (now < state.quietUntil) return;
  if (resolveOrganizationPluginId(serverId) === null) return;
  state.inFlight.add(agentId);
  state.queued.add(agentId);
  schedule(serverId);
}

export function readSessionOwnership(serverId: string, agentId: string): SessionOwnership {
  const entry = hosts.get(serverId)?.ownership.get(agentId);
  // An expired claim is not shown at all. Falling back to the derived placement says
  // less; it does not say something the app can no longer stand behind.
  return isFresh(entry, Date.now()) ? entry.ownership : UNASSIGNED_SESSION_OWNERSHIP;
}

export function subscribeSessionOwnership(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: drop every cached record, pending request and cooldown. */
export function resetSessionOwnershipStore(): void {
  for (const state of hosts.values()) {
    if (state.flushHandle !== null) clearTimeout(state.flushHandle);
  }
  hosts.clear();
  notify();
}

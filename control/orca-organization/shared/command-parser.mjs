import { planRadiusChange, validateRadiusPlan } from "./cc/radius-workflow.mjs";
import { canonicalJson } from "./cc/decision-rules.mjs";
import { validMapping } from "./tracker-refs.mjs";
import { validCursor } from "./history.mjs";
// Pure management command contract. No configuration, credentials, clocks or I/O.
// Child dispatch repeats this parser; journal state, signatures and authority remain child checks.
import { parseRef } from "./cc/refs.mjs";
import { validateDefinition } from "./cc/environment-rules.mjs";
import { remitScope } from "./cc/remit-rules.mjs";
import { itemProblem, mappingProblem } from "./cc/connector-rules.mjs";
import { pairProblem, evidenceProblem } from "./cc/link-rules.mjs";
const fail = () => {
  throw Error("Invalid controller command input");
};
const check = (predicate) => (value) => {
  if (!predicate(value)) fail();
  return value;
};
const str = (max, min = 1) =>
  check(
    (v) => typeof v === "string" && v.isWellFormed() && v.trim().length >= min && v.length <= max,
  );
const num = (min = 0, max = Number.MAX_SAFE_INTEGER - 1) =>
  check((v) => Number.isSafeInteger(v) && v >= min && v <= max);
const one = (...values) => check((v) => values.includes(v));
const opt = (schema) =>
  Object.assign((v) => (v === undefined ? undefined : schema(v)), { optional: true });
const nullable = (schema) => (v) => (v === null ? null : schema(v));
const either =
  (...schemas) =>
  (value) => {
    for (const schema of schemas) {
      try {
        return schema(value);
      } catch {}
    }
    fail();
  };
const array =
  (schema, max, min = 0) =>
  (v) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) fail();
    return v.map(schema);
  };
const object = (shape) => (v) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    fail();
  if (Object.keys(v).some((k) => !Object.hasOwn(shape, k))) fail();
  const result = {};
  for (const [k, schema] of Object.entries(shape)) {
    if (!Object.hasOwn(v, k) && !schema.optional) fail();
    if (Object.hasOwn(v, k)) result[k] = schema(v[k]);
  }
  return result;
};
const refinement = (schema, predicate) => (v) => {
  const result = schema(v);
  if (!predicate(result)) fail();
  return result;
};
const uuid = check(
  (v) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
);
const stamp = check(
  (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)),
);
const bool = check((v) => typeof v === "boolean"),
  none = check((v) => v == null);
const ref = check((v) => typeof v === "string" && !!parseRef(v));
const revision = num(),
  generation = num(1),
  reason = str(2000, 12),
  note = str(500, 0),
  key = check((v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v));
const primeSeat = check(
  (v) => typeof v === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(v),
);
const role = one("prime", "project-orchestrator"),
  seat = either(uuid, primeSeat),
  provider = one("claude", "codex");
const text = refinement(str(16384), (v) => new TextEncoder().encode(v).length <= 16384);
const common = { sessionId: uuid, expectedGeneration: generation },
  change = { expectedRevision: revision, note };
const worker = object(common),
  workers = array(worker, 6);
const defaults = object({
  modeId: opt(str(64)),
  thinkingOptionId: opt(one("off", "minimal", "low", "medium", "high", "xhigh", "max")),
  model: opt(str(200)),
  ask: opt(
    nullable(
      array(
        check((v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)),
        64,
      ),
    ),
  ),
});
// DESIGN-NEXT-BUILD A3: `role` says what the session is for (its defaults); `provider` may then be left to that role.
// FULCRA(light-role): every role the controller accepts (role-defaults-store DEFAULT_ROLES), not the closed shared-config
// list: review, research and light were refused here before reaching the controller.
const sessionRole = one(
  "planning",
  "orchestration",
  "implementation",
  "review",
  "research",
  "light",
);
const create = {
  messageId: uuid,
  taskId: uuid,
  provider: opt(provider),
  title: str(120, 3),
  host: opt(str(120)),
  defaults: opt(defaults),
  projectId: opt(uuid),
  role: opt(sessionRole),
};
const resume = { ...common, messageId: uuid, reason, workers };
const leadership = {
  ...common,
  messageId: uuid,
  destinationId: uuid,
  destinationGeneration: generation,
  maxWorkers: num(1, 6),
  context: str(8000, 12),
  workers,
};
const signature = check(
  (v) => typeof v === "string" && v.length <= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(v),
);
const device = object({
  label: str(80),
  platform: one("macos", "ios", "android", "windows", "linux"),
  publicKey: str(400),
  keyStorage: one(
    "secure-enclave",
    "keychain-biometric",
    "android-keystore",
    "os-protected",
    "software",
  ),
  userPresence: bool,
});
const proof = (payload) => object({ alg: one("ES256"), deviceId: uuid, payload, signature });
const signed = { messageId: uuid, at: stamp };
const scope = object({
  canAnswer: bool,
  levels: array(one(1, 2, 3), 3, 1),
  projects: either(one("all"), array(uuid, 64)),
});
const channel = { kind: one("discord-openclaw", "session", "cli"), label: str(80), scope };
const choice = {
  confirmDestructive: bool,
  expectedRevision: generation,
  id: uuid,
  messageId: uuid,
  note,
  optionId: str(64),
};
const choiceProof = proof(
  object({
    ...signed,
    confirmDestructive: bool,
    decisionId: uuid,
    digest: check((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)),
    note,
    optionId: str(64),
    revision: generation,
  }),
);
const link = {
  from: ref,
  relation: one(
    "worked-by",
    "produced",
    "fixes",
    "implements",
    "reviewed-by",
    "deployed",
    "decided-by",
    "supersedes",
  ),
  to: ref,
  evidence: nullable(str(300, 0)),
};
const validLink = (shape) =>
  refinement(
    object(shape),
    (a) => !pairProblem(a.from, a.relation, a.to) && !evidenceProblem(a.evidence),
  );
const seatCommand = (shape) =>
  refinement(object(shape), (a) => {
    try {
      (a.role === "prime" ? primeSeat : uuid)(a.seat);
      return !a.manager || a.role === "project-orchestrator";
    } catch {
      return false;
    }
  });
const roleChange = { expectedRevision: revision, note: reason };
const schemas = Object.create(null);
function methods(names, schema) {
  for (const name of names.split(" ")) {
    if (Object.hasOwn(schemas, name)) throw Error("Duplicate command schema");
    schemas[name] = schema;
  }
}
export const OWNED_CHANNEL_METHODS = Object.freeze([
  "controller-status",
  "controller-retry",
  "health",
]);
methods(OWNED_CHANNEL_METHODS.join(" "), none);
// Native owner status only. Not a controller read or a credential-promotable maintenance action.
export const NATIVE_OWNER_STATUS_METHODS = Object.freeze([
  "intercom-receipt-maintenance",
  "intercom-rate-settings-get",
]);
export const NATIVE_OWNER_METHODS = Object.freeze([
  ...NATIVE_OWNER_STATUS_METHODS,
  "radius-scratch-simulate",
  "radius-scratch-prune-and-simulate",
  "report-prime-register",
  "report-prime-promote",
  "report-prime-demote",
  "report-project-transfer",
  "report-parent-adopt",
  "report-registration-revoke",
  "intercom-rate-settings-set",
  "intercom-status",
  "report-inbox-owner-read",
  "evidence-index-owner-read",
  "artifact-tool-owner-set",
  "artifact-content-owner-set",
  "artifact-content-owner-list",
  "artifact-content-owner-read",
  "managed-artifact-index-owner-read",
]);
methods(NATIVE_OWNER_STATUS_METHODS.join(" "), none);
methods(
  "intercom-rate-settings-set",
  object({
    messageId: uuid,
    settings: object({
      report: num(0, 12),
      followup: num(0, 64),
      channel: num(0, 64),
      seat: num(0, 32),
    }),
  }),
);
methods("intercom-status", object({ agentId: uuid }));
const radiusPlan = (value) => {
  // Management canonicalizes keys; preserve the exact model fact and original revision.
  const rebuilt = planRadiusChange(value?.definition);
  if (canonicalJson(value) !== canonicalJson(rebuilt)) fail();
  validateRadiusPlan(rebuilt, value?.revision);
  return rebuilt;
};
const radiusInput = { attemptId: uuid, plan: radiusPlan, expectedRevision: str(16384) };
methods(
  "radius-scratch-simulate",
  refinement(object(radiusInput), (input) => input.expectedRevision === input.plan.revision),
);
methods(
  "radius-scratch-prune-and-simulate",
  refinement(
    object({ ...radiusInput, confirmDestructive: one(true) }),
    (input) => input.expectedRevision === input.plan.revision,
  ),
);
const reportIdentity = object({ agentId: uuid, instanceId: uuid, sessionId: str(200), boot: uuid });
methods(
  "artifact-content-owner-list",
  object({
    identity: reportIdentity,
    expectedEpoch: uuid,
    scope: object({ projectId: uuid, taskId: uuid }),
  }),
);
methods(
  "artifact-content-owner-set",
  object({
    messageId: uuid,
    grantId: uuid,
    identity: reportIdentity,
    expectedEpoch: uuid,
    scope: object({ projectId: uuid, taskId: uuid }),
    artifactIds: array(uuid, 24, 1),
    byteBudget: num(1, 131072),
    expiresAt: num(),
    expectedGrantRevision: nullable(uuid),
    enabled: one(true, false),
  }),
);
methods(
  "artifact-content-owner-read",
  object({
    requestId: uuid,
    grantId: uuid,
    grantRevision: uuid,
    artifactId: uuid,
    identity: reportIdentity,
    expectedEpoch: uuid,
    scope: object({ projectId: uuid, taskId: uuid }),
    offset: num(),
    length: num(1, 8192),
  }),
);
methods(
  "artifact-tool-owner-set",
  object({
    messageId: uuid,
    identity: reportIdentity,
    expectedEpoch: uuid,
    scope: object({ projectId: uuid, taskId: uuid }),
    enabled: one(true, false),
    expiresAt: num(),
  }),
);
methods(
  "report-inbox-owner-read evidence-index-owner-read managed-artifact-index-owner-read",
  object({
    identity: reportIdentity,
    expectedEpoch: uuid,
    scope: object({ projectId: uuid, taskId: uuid }),
  }),
);
const reportScopes = array(object({ projectId: uuid, taskId: uuid }), 16, 1);
methods(
  "report-prime-register",
  object({
    messageId: uuid,
    identity: reportIdentity,
    scopes: reportScopes,
    expectedEpoch: nullable(uuid),
  }),
);
const projectChanges = array(object({ projectId: uuid, expectedOwnerEpoch: nullable(uuid) }), 16);
methods(
  "report-prime-promote",
  object({
    messageId: uuid,
    identity: reportIdentity,
    expectedEpoch: nullable(uuid),
    scopes: reportScopes,
    projects: projectChanges,
  }),
);
methods(
  "report-prime-demote",
  object({
    messageId: uuid,
    identity: reportIdentity,
    expectedEpoch: uuid,
    parent: reportIdentity,
    expectedParentEpoch: uuid,
    projects: projectChanges,
  }),
);
methods(
  "report-project-transfer",
  object({
    messageId: uuid,
    projectId: uuid,
    from: nullable(reportIdentity),
    expectedFromEpoch: nullable(uuid),
    to: reportIdentity,
    expectedToEpoch: uuid,
    expectedOwnerEpoch: nullable(uuid),
  }),
);
methods(
  "report-parent-adopt",
  object({
    messageId: uuid,
    child: reportIdentity,
    parent: reportIdentity,
    scopes: reportScopes,
    expectedEpoch: nullable(uuid),
  }),
);
methods(
  "report-registration-revoke",
  object({ messageId: uuid, identity: reportIdentity, expectedEpoch: uuid }),
);
methods(
  "bindings-activation bindings-status recovery-status wakes-status channels-status channels-requests roles-session-requests roles-allowances trackers-status trackers-directory cc-tracker-legacy-pending decisions-inbox decisions-digest-run cc-channels-list devices-list devices-pair-open remits-list manager-summary events-status list task-index quota-status leadership-status permissions-status",
  none,
);
methods(
  "bindings-project roles-ownership trackers-project trackers-history cc-link-history cc-tracker-mapping-history task-authority history management-ack recover observe",
  uuid,
);
methods("task-allowance", uuid);
methods(
  "bindings-assign",
  seatCommand({
    ...roleChange,
    expectedSessionGeneration: generation,
    role,
    seat,
    sessionId: uuid,
    manager: opt(object({ maxWorkers: num(1, 6), reason })),
  }),
);
methods(
  "bindings-unassign",
  seatCommand({ ...roleChange, expectedRevision: generation, role, seat }),
);
methods(
  "seat-unhold",
  object({ ...roleChange, expectedRevision: generation, role: one("prime"), seat: primeSeat }),
);
methods("bindings-route", seatCommand({ role, seat }));
methods("seat-inbox", object({ role: one("prime"), seat: primeSeat }));
methods("bindings-grant sessions-refresh-tools", object(common));
methods("sessions-tool-surface", object({ sessionId: uuid }));
methods(
  "seat-hold",
  object({
    ...roleChange,
    expectedRevision: generation,
    expectedSessionGeneration: generation,
    role: one("prime"),
    seat: primeSeat,
  }),
);
methods("seat-receipt", object({ channelId: uuid, messageId: uuid, note: str(2000, 8) }));
methods(
  "seat-reply",
  object({
    channelId: uuid,
    expectedHolderGeneration: generation,
    expectedSeatRevision: generation,
    inReplyTo: uuid,
    messageId: uuid,
    text,
  }),
);
methods("seat-reply-reconcile disposition", object({ messageId: uuid, reason }));
methods(
  "channels-open",
  object({
    expectedPrimeRevision: generation,
    expectedProjectRevision: generation,
    expiresAt: stamp,
    maxMessages: num(1, 64),
    primeSeat,
    projectSeat: uuid,
    purpose: reason,
  }),
);
methods("channels-close", object({ channelId: uuid, note: reason }));
methods("channels-request-decline", object({ note: reason, requestId: uuid }));
methods(
  "worktree-lifecycle-settings",
  object({
    archiveFinished: opt(bool),
    idleMinutes: opt(either(one("never"), num(1, 10080))),
    retentionDays: opt(either(one("never"), num(0, 36500))),
  }),
);
methods(
  "worktree-lifecycle-now",
  either(
    object({ requestId: uuid }),
    either(object({ previewId: uuid, requestId: uuid }), object({ operationId: uuid })),
  ),
);
methods("worktree-lifecycle-preview", either(none, object({ operationId: opt(uuid) })));
methods("worktree-lifecycle-apply", object({ confirm: one(true), planId: uuid }));
methods(
  "worktree-lifecycle-retention",
  object({ retentionDays: either(one("never"), num(0, 36500)) }),
);
methods("session-defaults", either(none, object({ claude: opt(defaults), codex: opt(defaults) })));
methods(
  "roles-request-session",
  object({ ...roleChange, provider, seat: uuid, taskId: uuid, title: str(120, 3) }),
);
methods("roles-adopt", object({ ...roleChange, request: uuid, seat: uuid }));
// Fulcra 0.2.8: build the team from chats that already exist (src/control/team.mjs). Owner-only writes.
methods("team-enrol", object({ note: reason, sessionId: uuid, taskId: uuid }));
methods(
  "team-project-create",
  object({ description: opt(nullable(str(2000))), name: str(160), note: reason }),
);
methods("team-project-anchor team-project-archive", object({ note: reason, projectId: uuid }));
methods("team-history", either(none, object({ limit: num(1, 200) })));
methods("roles-allowance-set", seatCommand({ ...roleChange, maxSessions: num(0, 32), role, seat }));
methods(
  "trackers-map",
  refinement(
    object({
      ...change,
      auth: one("keychain", "gh-cli"),
      project: uuid,
      remoteId: str(256),
      remoteName: str(256),
      site: str(253),
      tracker: one("github", "jira", "bitbucket"),
      validatedAt: stamp,
    }),
    validMapping,
  ),
);
methods("trackers-unmap", object({ ...change, expectedRevision: generation, project: uuid }));
methods(
  "trackers-link",
  object({
    expectedMappingRevision: generation,
    itemRef: str(256),
    project: uuid,
    subject: object({ kind: one("session", "task"), id: uuid }),
  }),
);
methods("trackers-unlink", object({ expectedRevision: generation, link: uuid }));
methods("trackers-links-for", object({ subjects: array(uuid, 64) }));
methods(
  "cc-tracker-map",
  refinement(
    object({
      ...change,
      accountId: nullable(uuid),
      connector: key,
      messageId: uuid,
      projectId: uuid,
      remoteId: str(256),
      remoteName: str(256),
      site: nullable(str(253)),
    }),
    (a) => !mappingProblem(a),
  ),
);
methods(
  "cc-tracker-unmap",
  object({ ...change, expectedRevision: generation, id: uuid, messageId: uuid }),
);
methods("cc-tracker-mappings", either(none, object({ projectId: uuid })));
methods(
  "cc-tracker-import-legacy",
  object({ accountId: nullable(uuid), messageId: uuid, projectId: uuid }),
);
methods(
  "cc-tracker-items-put",
  object({
    items: array(
      check((v) => !itemProblem(v)),
      200,
    ),
    mappingId: uuid,
    observedAt: stamp,
    observation: opt(object({ id: uuid, partial: bool, final: bool })),
  }),
);
methods("cc-tracker-items environments-view briefs-read", object({ projectId: uuid }));
methods("cc-links-set", validLink({ ...link, expectedRevision: revision, messageId: uuid }));
methods("cc-links-remove", object({ expectedRevision: generation, id: uuid, messageId: uuid }));
methods(
  "cc-links-observe",
  object({
    messageId: uuid,
    links: array(
      validLink({
        ...link,
        provenance: one("reported", "inferred"),
        confidence: one("high", "medium", "low"),
      }),
      500,
    ),
  }),
);
methods("cc-links-for", object({ refs: array(ref, 128), includeRemoved: opt(bool) }));
methods("decisions-get decisions-digest", object({ id: uuid }));
methods(
  "decisions-record-review",
  object({
    workspace: str(1024),
    repo: str(140),
    number: num(1, 2147483647),
    headSha: check((v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v)),
    choice: one("approve", "request_changes", "comment"),
    note,
    projectId: opt(nullable(uuid)),
    via: opt(one("app-mac", "app-ios", "app-android", "app-windows", "app-linux", "app-web")),
  }),
);
methods(
  "decisions-choose",
  object({
    ...choice,
    via: opt(one("app-mac", "app-ios", "app-android", "app-windows", "app-linux", "app-web")),
    proof: opt(choiceProof),
  }),
);
methods("decisions-held-message", object({ channelId: uuid, messageId: uuid }));
methods(
  "environments-propose",
  object({
    messageId: uuid,
    projectId: uuid,
    environmentId: nullable(uuid),
    expectedRevision: revision,
    definition: validateDefinition,
    note,
  }),
);
methods(
  "promotions-create",
  object({
    messageId: uuid,
    projectId: uuid,
    from: uuid,
    to: uuid,
    commit: ref,
    expectedRevision: revision,
  }),
);
methods(
  "promotions-cancel",
  object({ messageId: uuid, id: uuid, expectedRevision: revision, note }),
);
methods(
  "devices-pair-complete",
  object({
    payload: object({
      ...signed,
      purpose: one("fulcra.device.pair"),
      windowId: uuid,
      code: check((v) => typeof v === "string" && /^\d{6}$/.test(v)),
      device,
    }),
    signature,
  }),
);
methods(
  "devices-pair-approve",
  object({
    approval: proof(object({ ...signed, purpose: one("fulcra.device.approve"), device })),
    device,
    signature,
  }),
);
methods(
  "devices-revoke",
  object({
    proof: proof(object({ ...signed, purpose: one("fulcra.device.revoke"), deviceId: uuid })),
  }),
);
methods(
  "cc-channel-pair-open",
  object({
    ...channel,
    proof: opt(proof(object({ ...signed, ...channel, purpose: one("fulcra.channel.pair-open") }))),
  }),
);
methods(
  "cc-channel-pause cc-channel-resume cc-channel-revoke",
  object({ id: uuid, expectedRevision: generation }),
);
methods(
  "remits-assign",
  object({ ...change, note: str(500, 12), messageId: uuid, primeSeat: key, scope: remitScope }),
);
methods(
  "remits-move",
  object({ ...change, note: str(500, 12), messageId: uuid, remitId: uuid, toPrimeSeat: key }),
);
methods("remits-end", object({ ...change, note: str(500, 12), messageId: uuid, remitId: uuid }));
methods(
  "remits-domain-set",
  object({
    ...change,
    note: str(500, 12),
    messageId: uuid,
    projectId: uuid,
    domain: nullable(key),
  }),
);
methods("manager-promote", object({ ...common, maxWorkers: num(1, 6), reason }));
methods(
  "manager-grant",
  object({ ...common, maxWorkers: num(1, 6), reason, capability: str(512) }),
);
methods("manager-resume", object(resume));
methods("leadership-transfer", object(leadership));
methods(
  "events-attach",
  object({ capability: str(512), reason, supervisorId: uuid, workerId: uuid }),
);
methods("events-resume", object({ reason, workerId: uuid }));
methods("operator-send", object({ ...common, messageId: uuid, text }));
methods("operator-native-queue", object({ ...common, messageId: uuid, text }));
methods("create", object(create));
methods("takeover reestablish", object({ sessionId: uuid, reason }));
methods("handback", object({ sessionId: uuid, reason, expectedGeneration: opt(generation) }));
methods("permissions-grant permissions-revoke", object({ ...common, reason }));
// W1's adapter may include the redundant manual reason; limit is host-owned only.
methods("session-takeover", object({ session: uuid, accountId: uuid, reason: opt(one("manual")) }));
methods(
  "session-resume",
  object({
    ...common,
    interruptionId: uuid,
    messageId: uuid,
    reason,
    continuation: opt(str(4000, 0)),
  }),
);
methods(
  "session-resume-batch",
  object({
    items: array(object({ ...common, interruptionId: uuid }), 8, 1),
    messageId: uuid,
    reason,
  }),
);
methods("session-interruption-dismiss", object({ interruptionId: uuid, reason }));
methods("session-fresh-start", object({ messageId: uuid, sessionId: uuid, reason }));
methods("wakes-heartbeat-set", object({ minutes: num(0, 1440), note: reason }));
methods(
  "task-allowance-set",
  object({
    expectedRevision: revision,
    maxInstructions: nullable(num(0, 1000)),
    reason,
    taskId: uuid,
  }),
);
methods("operator-artifacts", object({ ...common, taskId: uuid }));
methods("activity-receipts", object({ sessionId: uuid, taskId: uuid }));
methods("book-activity", object({ sessionId: uuid, taskId: uuid }));
methods(
  "book-activity-page",
  object({
    sessionId: uuid,
    taskId: uuid,
    cursor: nullable(check(validCursor)),
    includeMessages: opt(one(true)),
  }),
);
methods("management-prepare", (value) => {
  const a = object({
    kind: one("create", "send", "resume", "leadership"),
    messageId: uuid,
    body: check((v) => v && typeof v === "object" && !Array.isArray(v)),
  })(value);
  const shape = { create, send: { ...common, messageId: uuid, text }, resume, leadership }[a.kind];
  const { messageId: _, ...body } = shape;
  return { ...a, body: object(body)(a.body) };
});
export const MANAGEMENT_METHODS = Object.freeze(Object.keys(schemas));
function dataOnly(value, seen = new Set(), depth = 0) {
  if (depth > 32 || seen.has(value)) fail();
  if (
    value === null ||
    ["string", "boolean"].includes(typeof value) ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    result[key] = dataOnly(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}
export function parseControllerCommand(value) {
  value = dataOnly(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32768) fail();
  const command = object({ method: str(100), input: opt((v) => v) })(value);
  if (!Object.hasOwn(schemas, command.method)) throw Error("Unknown controller method");
  const input = schemas[command.method](command.input);
  return Object.freeze({ method: command.method, ...(input === undefined ? {} : { input }) });
}
// Closed authenticated read-method subset. It grants no socket authority.
// Operator-authenticated reads. worktree-lifecycle-preview is included on purpose (R13-V1 option (a)):
// it is a dry run with no persisted effect, so a read failure maps to "unavailable" rather than
// "uncertain"; apply and retention remain writes. This one list also drives the operator-socket channel
// waiver and read-only plugin invocation; splitting those authority uses from outcome mapping is backlog.
export const READ_METHODS = Object.freeze([
  "team-history",
  "worktree-lifecycle-preview",
  "controller-status",
  "health",
  "bindings-activation",
  "bindings-status",
  "bindings-project",
  "bindings-route",
  "sessions-tool-surface",
  "seat-inbox",
  "recovery-status",
  "wakes-status",
  "channels-status",
  "channels-requests",
  "session-defaults",
  "roles-session-requests",
  "roles-allowances",
  "roles-ownership",
  "trackers-project",
  "trackers-links-for",
  "trackers-status",
  "trackers-history",
  "trackers-directory",
  "cc-tracker-mappings",
  "cc-tracker-legacy-pending",
  "cc-tracker-items",
  "cc-tracker-mapping-history",
  "cc-links-for",
  "cc-link-history",
  "decisions-inbox",
  "environments-view",
  "decisions-get",
  "cc-channels-list",
  "devices-list",
  "decisions-held-message",
  "decisions-digest",
  "remits-list",
  "briefs-read",
  "manager-summary",
  "events-status",
  "list",
  "task-index",
  "task-authority",
  "history",
  "book-activity",
  "book-activity-page",
  "activity-receipts",
  "quota-status",
  "task-allowance",
  "permissions-status",
  "leadership-status",
  "operator-artifacts",
]);

import { defineContract } from "./rpc-contract";
import { z } from "zod";

/**
 * Explicit leadership role seats, read from the controller's own role bindings.
 *
 * A seat is an accountability record and nothing more: assigning one transfers no control, starts
 * no session, grants no task authority and sends no prompt. The controller says so on every reply
 * and this surface repeats it rather than implying otherwise.
 *
 * Two seat identities exist and they are not interchangeable. A prime seat is a short board-level
 * slug over the programme root. A project orchestrator seat *is* the registered project UUID — not
 * a task ID, and never derived from one.
 *
 * `available: false` means the role records could not be read. It is not "no seats": an unreadable
 * binding table can neither name a leader nor rule one out, and the UI must not collapse the two.
 */

const id = z.string().uuid();
const note = z.string().max(2000);
const stamp = z.string().max(64);

export const ROLES = ["prime", "project-orchestrator"] as const;
/** Mirrors the controller's own seat slug rule; a project seat is validated as a UUID instead. */
export const PRIME_SEAT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Never carries the bound session's `cwd` or any credential. The server rebuilds this field by
 * field from the controller reply instead of spreading it, so a new controller field cannot reach
 * the renderer by accident.
 */
export const seatSchema = z
  .object({
    role: z.enum(ROLES),
    seat: z.string().min(1).max(64),
    projectId: id.nullable(),
    state: z.enum(["assigned", "vacant"]),
    revision: z.number().int().nonnegative(),
    task: id.nullable(),
    sessionId: id.nullable(),
    /** Enough to route a conversation and to fence a write. No working directory, no capability. */
    session: z
      .object({ id, task: id, mode: z.string().max(32), generation: z.number().int().min(1) })
      .strict()
      .nullable(),
    note: note.nullable(),
    at: stamp.nullable(),
    membershipAt: stamp.nullable(),
    sessionPresent: z.boolean(),
    sessionGenerationChanged: z.boolean(),
    sessionTaskMatches: z.boolean(),
    /** Remote seats have no dispatch path; the reason is the controller's own words. */
    dispatch: z
      .object({ host: z.string().max(32), supported: z.boolean(), reason: note.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type Seat = z.infer<typeof seatSchema>;

/**
 * A session recorded on one of a project's member workstreams.
 *
 * This is *membership*, not ownership: `bindings-project` reports which sessions sit on the
 * project's tasks, and that is a different question from who owns them. Ownership is a separate
 * per-session controller read (`roles-ownership`) and is never inferred from this list.
 */
export const projectSession = z
  .object({
    sessionId: id,
    taskId: id,
    mode: z.string().max(32),
    generation: z.number().int().min(1),
  })
  .strict();

/** A thing the project needs, or something blocking it. Flattened from the controller's variants. */
export const roleNeed = z
  .object({
    kind: z.string().max(64),
    detail: note,
    taskId: id.nullable(),
    sessionId: id.nullable(),
    at: stamp.nullable(),
  })
  .strict();

const membership = z
  .object({
    known: z.boolean(),
    available: z.boolean(),
    partial: z.boolean(),
    observedAt: stamp.nullable(),
    memberTaskCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    note: note,
  })
  .strict();

const progress = z
  .object({
    memberTasks: z.number().int().nonnegative(),
    recorded: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    truncated: z.boolean(),
    basis: note,
  })
  .strict();

/** Every seat the controller records, plus whether the read succeeded at all. */
export const roleDirectoryRpc = defineContract({
  name: "organization.role-directory",
  input: z.object({}).strict(),
  output: z
    .object({
      observedAt: z.string().datetime(),
      available: z.boolean(),
      /** Present only when `available` is false; the controller's own refusal, never invented. */
      unavailable: note.nullable(),
      primes: z.array(seatSchema).max(64),
      projectSeats: z.array(seatSchema).max(128),
      programme: id.nullable(),
      note: note,
    })
    .strict(),
});

/** Clicking a project: its recorded orchestrator, the escalation address, and what it needs. */
export const roleProjectRpc = defineContract({
  name: "organization.role-project",
  input: z.object({ projectId: id }).strict(),
  output: z
    .object({
      observedAt: z.string().datetime(),
      available: z.boolean(),
      unavailable: note.nullable(),
      projectId: id,
      /** Null when the project source could not confirm this project; not the same as no leader. */
      summary: z
        .object({
          id,
          name: z.string().max(160),
          description: z.string().max(2000).nullable(),
          status: z.string().max(64),
        })
        .strict()
        .nullable(),
      membership: membership.nullable(),
      leader: seatSchema.nullable(),
      primes: z.array(seatSchema).max(64),
      progress: progress.nullable(),
      needed: z.array(roleNeed).max(64),
      blockers: z.array(roleNeed).max(64),
      /** Sessions recorded on this project's member tasks. Membership, not ownership. */
      sessions: z.array(projectSession).max(128),
      note: note,
    })
    .strict(),
});

/**
 * Assign, replace or vacate a seat. `expectedRevision` and `expectedSessionGeneration` must be the
 * values actually observed in a read — the controller refuses a stale writer, which is the point.
 * Replacing is an assign onto an occupied seat; the controller reports which it did in `action`.
 */
export const roleAssignRpc = defineContract({
  name: "organization.role-assign",
  input: z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("assign"),
        role: z.enum(ROLES),
        seat: z.string().min(1).max(64),
        sessionId: id,
        expectedRevision: z.number().int().nonnegative(),
        expectedSessionGeneration: z.number().int().min(1),
        reason: z.string().min(12).max(2000),
      })
      .strict(),
    z
      .object({
        action: z.literal("vacate"),
        role: z.enum(ROLES),
        seat: z.string().min(1).max(64),
        expectedRevision: z.number().int().min(1),
        reason: z.string().min(12).max(2000),
      })
      .strict(),
  ]),
  output: z
    .object({
      status: z.enum(["assigned", "replaced", "reaffirmed", "vacated", "error"]),
      message: note,
      observedAt: z.string().datetime(),
      role: z.enum(ROLES).nullable(),
      seat: z.string().max(64).nullable(),
      revision: z.number().int().nonnegative().nullable(),
      sessionId: id.nullable(),
      previousSessionId: id.nullable(),
      /** Always false. A seat records accountability; it never grants authority. */
      grantsAuthority: z.literal(false),
    })
    .strict(),
});

/**
 * Ask a project's orchestrator seat for a session.
 *
 * This does **not** create a session. `roles-request-session` publishes a *request* row in state
 * `pending`; the seat is then woken and fulfils it, and a session appears afterwards. The honest
 * rendering is therefore "a request was made of the seat", never "a session was created" — showing
 * a session that does not exist yet would be the exact fabrication this surface exists to avoid.
 *
 * The app names the seat, its observed revision and a member workstream. It mints no identity and
 * passes no ownership claim; ownership is recorded controller-side and read back separately.
 */
export const projectRequestSessionRpc = defineContract({
  name: "organization.project-request-session",
  input: z
    .object({
      /** The seat asked to do the work. A project orchestrator seat is the project UUID. */
      seat: id,
      /** Seat revision actually observed, so a replaced or vacated seat cannot be spent. */
      expectedRevision: z.number().int().min(1),
      taskId: id,
      provider: z.enum(["claude", "codex"]),
      title: z.string().min(3).max(120),
      reason: z.string().min(12).max(2000),
    })
    .strict(),
  output: z
    .object({
      /**
       * `requested` means a request row exists and the seat has been asked. `unavailable` means this
       * controller does not expose seat requests — the state on the running controller today.
       */
      status: z.enum(["requested", "refused", "unavailable"]),
      message: note,
      observedAt: z.string().datetime(),
      requestId: id.nullable(),
      state: z.string().max(32).nullable(),
      /** Always false: asking a seat for work grants the seat no authority over the result. */
      grantsAuthority: z.literal(false),
    })
    .strict(),
});

/** One outstanding request published against a seat. */
export const sessionRequest = z
  .object({
    requestId: id,
    seat: z.string().max(64),
    seatRole: z.string().max(32).nullable(),
    taskId: id.nullable(),
    provider: z.string().max(32).nullable(),
    title: z.string().max(160).nullable(),
    state: z.string().max(32),
    sessionId: id.nullable(),
    at: stamp.nullable(),
    detail: note.nullable(),
  })
  .strict();

/** Outstanding seat requests, so an asked-for session is visible before it exists. */
export const sessionRequestsRpc = defineContract({
  name: "organization.project-session-requests",
  input: z.object({}).strict(),
  output: z
    .object({
      observedAt: z.string().datetime(),
      available: z.boolean(),
      unavailable: note.nullable(),
      requests: z.array(sessionRequest).max(128),
    })
    .strict(),
});

/**
 * Controller ownership and validated supervision display states.
 *
 * `recorded` — the session was created *through a seat*, i.e. everything the request/accept flow
 * produces. This is the normal healthy state for seat-created work, not an edge case, and it is
 * the state the whole point of routing work through an orchestrator generates.
 * `declared` — an operator recorded the project at creation. Owned by the project and led by
 * *nobody* until an operator adopts it. The bootstrap path by which a project's first leader
 * is created.
 * `adopted` — an operator placed an already-declared session under a seat.
 * `managed` — a current validated manager link, without a role-session ownership record.
 * `unknown` — neither recorded ownership nor a validated manager can be established.
 *
 * Omitting any owned state here makes the seam return null for it, which the app renders as
 * unassigned — so a session the controller *does* place would display as unowned. That is the
 * failure this list exists to prevent; it must stay in step with the controller's own states.
 */
export const OWNERSHIP_STATE = ["unknown", "recorded", "declared", "adopted", "managed"] as const;
export type OwnershipState = (typeof OWNERSHIP_STATE)[number];

/**
 * Normalise a wire value to a known state. Anything unrecognised becomes `unknown` — never a
 * concrete state. This covers the *controller sends something new* direction.
 */
export function ownershipStateOf(value: unknown): OwnershipState {
  return (OWNERSHIP_STATE as readonly string[]).includes(value as string)
    ? (value as OwnershipState)
    : "unknown";
}

/**
 * Does this state place the session in a project?
 *
 * Exhaustive with a `never` default, so the *maintainer adds a state* direction is a compile
 * error here rather than a silent classification six months later. It also fails closed: an
 * unreachable value returns false, which renders as `unknown` rather than as a placed session.
 *
 * Deliberately not a Set of literals: a Set would accept a new state silently, which is exactly
 * the shape of the defect this replaces.
 */
export function placesSession(state: OwnershipState): boolean {
  switch (state) {
    case "unknown":
    case "managed":
      return false; // A validated manager is not a project/role ownership record.
    case "recorded":
    case "declared":
    case "adopted":
      return true;
    default: {
      const unhandled: never = state;
      void unhandled;
      return false;
    }
  }
}

/** `detail` is the controller's own sentence. It is written to be shown, so it is shown. */
export const ownershipRecord = z
  .object({
    sessionId: id,
    ownership: z.enum(OWNERSHIP_STATE),
    projectId: id.nullable(),
    seat: z.string().max(64).nullable(),
    seatRole: z.string().max(32).nullable(),
    declaredBy: z.string().max(64).nullable(),
    parentSession: id.nullable(),
    at: stamp.nullable(),
    detail: note,
  })
  .strict();

/**
 * The seam the app reads (`packages/app/src/sessions/use-session-ownership.ts`).
 *
 * Preserve the controller distinction. `declared` is owned by the project and led by *nobody* — the bootstrap state an
 * operator must resolve by adopting. `adopted` is led by a seat. `unknown` is the controller
 * being unable to place the session at all. `managed` names validated supervision without
 * assigning a project or granting role-session commands.
 *
 * `unknown` is carried as a **record**, not as `null`, and `projectId`/`projectName` are nullable
 * so it can be. On the wire `null` now means only "this agent is not a controller session I could
 * resolve" — a separate fact. Collapsing unknown into null would make a session the controller
 * cannot place render exactly like one it positively knows is unowned, which is the failure this
 * whole surface exists to prevent.
 *
 * The controller returns ids and a sentence; resolving `projectName`, `taskTitle`,
 * `leaderAgentId` and `leaderTitle` is this plugin's job, which is why the join lives here.
 */
export const appOwnershipRecord = z
  .object({
    /** Null when the project is not recorded, including managed workers. */
    projectId: z.string().max(64).nullable(),
    projectName: z.string().max(160).nullable(),
    taskId: z.string().max(64).nullable(),
    taskTitle: z.string().max(512).nullable(),
    /** Null for `declared`: owned by the project, led by nobody until an operator adopts it.
     *  Present for `recorded` and `adopted`, both of which name a seat. */
    leaderAgentId: z.string().max(64).nullable(),
    leaderTitle: z.string().max(512).nullable(),
    /**
     * `state`, not `status`: in this codebase `status` already means health or lifecycle
     * (`ProviderStatus`, `PluginListItem.status`, `lastStatus`, the workspace buckets), and reusing
     * it here invites a reader to take `unknown` as *unhealthy* rather than *not established*.
     */
    state: z.enum(OWNERSHIP_STATE),
    /**
     * `detail`, not `reason`: the controller's sentence is valid in all states, including the
     * healthy ones. `reason` reads as "why it failed" and would discourage sending it on the very
     * path a person most wants explained. Rendered as written; the app invents no wording.
     */
    detail: z.string().max(2000).nullable(),
  })
  .strict();

/**
 * Adopt a declared session into a seat.
 *
 * Operator-only by design: a seat must not be able to grow its own ownership. Adoption **spends
 * the seat's allowance**, because an allowance that bounded only sessions a seat *started* would
 * bound nothing — a seat at its limit could keep growing by having sessions declared and then
 * adopted into it.
 */
export const roleAdoptRpc = defineContract({
  name: "organization.role-adopt",
  input: z
    .object({
      seat: id,
      /** Seat revision actually observed; the allowance is pinned to it. */
      expectedRevision: z.number().int().min(1),
      /**
       * The **creation record** the ownership row is keyed by — not the session id. A session is
       * adopted by naming how it came into existence, which is what the ownership join uses.
       */
      request: id,
      reason: z.string().min(12).max(2000),
    })
    .strict(),
  output: z
    .object({
      status: z.enum(["adopted", "refused", "unavailable"]),
      message: note,
      observedAt: z.string().datetime(),
      sessionId: id.nullable(),
      seat: z.string().max(64).nullable(),
      /** Allowance left after this adoption, when the controller reports it. */
      remaining: z.number().int().nonnegative().nullable(),
      grantsAuthority: z.literal(false),
    })
    .strict(),
});

/**
 * A seat's operator-granted session allowance.
 *
 * Pinned to a seat **revision**: replacing a leader resets `used` while the project still lists
 * the sessions the previous holder owned, so the successor can do nothing until an operator grants
 * a fresh allowance. That is operator-in-the-loop by design, and the surface says so rather than
 * letting it read as a bug.
 */
export const seatAllowance = z
  .object({
    seat: z.string().max(64),
    role: z.string().max(32).nullable(),
    /** The seat revision this allowance is pinned to. */
    revision: z.number().int().nonnegative().nullable(),
    limit: z.number().int().nonnegative().nullable(),
    used: z.number().int().nonnegative().nullable(),
    remaining: z.number().int().nonnegative().nullable(),
    /** False when the allowance is pinned to a revision the seat no longer has. */
    current: z.boolean(),
    detail: note.nullable(),
  })
  .strict();

export const roleAllowancesRpc = defineContract({
  name: "organization.role-allowances",
  input: z.object({}).strict(),
  output: z
    .object({
      observedAt: z.string().datetime(),
      available: z.boolean(),
      unavailable: note.nullable(),
      allowances: z.array(seatAllowance).max(128),
    })
    .strict(),
});

/** Grant or change a seat's allowance. Operator-only, fenced on the observed seat revision. */
export const roleAllowanceSetRpc = defineContract({
  name: "organization.role-allowance-set",
  input: z
    .object({
      seat: z.string().min(1).max(64),
      /** Required by the controller: a seat identity is (role, seat), not the slug alone. */
      role: z.enum(ROLES),
      expectedRevision: z.number().int().min(1),
      /** The controller's bound: 0 to 32 inclusive. */
      maxSessions: z.number().int().min(0).max(32),
      reason: z.string().min(12).max(2000),
    })
    .strict(),
  output: z
    .object({
      status: z.enum(["granted", "refused", "unavailable"]),
      message: note,
      observedAt: z.string().datetime(),
      seat: z.string().max(64).nullable(),
      maxSessions: z.number().int().nonnegative().nullable(),
      remaining: z.number().int().nonnegative().nullable(),
      grantsAuthority: z.literal(false),
    })
    .strict(),
});

export const sessionOwnershipRpc = defineContract({
  // NOT "organization.sessionOwnership": @getpaseo/plugin validates method names against
  // /^[a-z][a-z0-9._-]*$/ and refuses any uppercase character at registration time. The app seam
  // must call this kebab-case name; see project-orchestrator-wiring.md.
  name: "organization.session-ownership",
  input: z.object({ agentIds: z.array(z.string().max(64)).max(128) }).strict(),
  output: z.object({ ownership: z.record(z.string(), appOwnershipRecord.nullable()) }).strict(),
});

export type RoleDirectory = z.infer<typeof roleDirectoryRpc.output>;
export type RoleProject = z.infer<typeof roleProjectRpc.output>;
export type RoleAssignResult = z.infer<typeof roleAssignRpc.output>;
export type ProjectSession = z.infer<typeof projectSession>;
export type RequestSessionResult = z.infer<typeof projectRequestSessionRpc.output>;
export type SessionRequest = z.infer<typeof sessionRequest>;
export type OwnershipRecord = z.infer<typeof ownershipRecord>;
export type AppOwnershipRecord = z.infer<typeof appOwnershipRecord>;
export type SeatAllowance = z.infer<typeof seatAllowance>;
export type AdoptResult = z.infer<typeof roleAdoptRpc.output>;
export type AllowanceSetResult = z.infer<typeof roleAllowanceSetRpc.output>;

/**
 * Controller methods this plugin calls, named in one place.
 *
 * `bindings-status`, `bindings-project`, `bindings-assign` and `bindings-unassign` exist today.
 * `roles-request-session`, `roles-session-requests` and `roles-ownership` are the owned-execution
 * methods landed in b71f789c, confirmed against controller source. An unknown method surfaces as
 * `unavailable`, never as a fabricated success.
 */
export const CONTROLLER_METHOD = {
  directory: "bindings-status",
  project: "bindings-project",
  assign: "bindings-assign",
  unassign: "bindings-unassign",
  requestSession: "roles-request-session",
  sessionRequests: "roles-session-requests",
  ownership: "roles-ownership",
  adopt: "roles-adopt",
  allowances: "roles-allowances",
  allowanceSet: "roles-allowance-set",
} as const;

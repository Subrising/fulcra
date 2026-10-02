import { defineContract } from "./rpc-contract";
import { z } from "zod";
import { OWNERSHIP_STATE, roleNeed, seatSchema } from "./roles";
import { linkedIssuesResult } from "./linked-issues";

/**
 * The Fulcra work map: prime → projects → workstreams → sessions, read-only.
 *
 * Two reads and no writes. The overview is cheap (seat table, channel table, project directory,
 * the fleet the Live work tab already reads); one project's detail costs one `bindings-project`
 * and is only asked for while that project is expanded.
 *
 * A workstream is a project's member task. The controller has no separate workstream entity and
 * this contract does not invent one.
 *
 * Every schema is `.strict()` and every string bounded: the server rebuilds each object field by
 * field, and a controller field that is not listed here fails the parse instead of reaching the
 * renderer. There is deliberately no `cwd`, capability, grant path or message text anywhere below.
 */

const id = z.string().uuid();
const stamp = z.string().max(64);
const note = z.string().max(2000);

/** A seat as the map shows it: the leadership seat plus whether a human hold covers it. */
export const mapSeat = seatSchema
  .extend({
    /** `effective`: the controller's heldBy() matches this revision and holder. `declared`: a hold row exists but does not apply. */
    hold: z.enum(["effective", "declared"]).nullable(),
  })
  .strict();
export type MapSeat = z.infer<typeof mapSeat>;

/** Runtime facts from the daemon (the Live work fleet). Null when the fleet did not observe it. */
export const mapRuntime = z
  .object({
    title: z.string().max(160),
    provider: z.string().max(64),
    model: z.string().max(64).nullable(),
    host: z.string().min(1).max(256),
    status: z.string().max(32),
    pending: z.number().int().nonnegative().nullable(),
    error: z.string().max(200).nullable(),
    updatedAt: stamp.nullable(),
  })
  .strict();
export type MapRuntime = z.infer<typeof mapRuntime>;

export const mapChannel = z
  .object({
    primeSeat: z.string().max(64),
    state: z.string().max(32),
    open: z.boolean(),
  })
  .strict();

export const mapAttention = z
  .object({
    kind: z.string().max(64),
    detail: z.string().max(500),
    projectId: id.nullable(),
    taskId: id.nullable(),
    sessionId: id.nullable(),
  })
  .strict();
export type MapAttention = z.infer<typeof mapAttention>;

export const mapProject = z
  .object({
    projectId: id,
    /** Null when the project source could not name it; the seat alone gives only the UUID. */
    name: z.string().max(160).nullable(),
    status: z.string().max(64).nullable(),
    seat: mapSeat.nullable(),
    channels: z.array(mapChannel).max(16),
    /** Member tasks the project directory confirmed. Null when membership is unknown. */
    workstreams: z.number().int().nonnegative().nullable(),
    /** Sessions the fleet observed on this project's member tasks (overview count only). */
    sessions: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
  })
  .strict();
export type MapProject = z.infer<typeof mapProject>;

export const mapSessionSummary = z
  .object({
    sessionId: id,
    taskId: id,
    mode: z.string().max(32),
    runtime: mapRuntime.nullable(),
  })
  .strict();

export const workMapOverview = z
  .object({
    observedAt: z.string().datetime(),
    /** Seats could be read. False is "unknown", never "no seats". */
    available: z.boolean(),
    unavailable: note.nullable(),
    primes: z.array(mapSeat).max(64),
    projects: z.array(mapProject).max(128),
    /** Sessions on no member task of any known project, or when membership is unknown. */
    unplaced: z.array(mapSessionSummary).max(64),
    attention: z.array(mapAttention).max(64),
    sources: z
      .object({
        seats: z.boolean(),
        channels: z.boolean(),
        projects: z
          .object({ available: z.boolean(), partial: z.boolean(), note: z.string().max(512) })
          .strict(),
        fleet: z
          .object({ available: z.boolean(), partial: z.boolean(), observedAt: stamp.nullable() })
          .strict(),
      })
      .strict(),
    note: note,
  })
  .strict();
export type WorkMapOverview = z.infer<typeof workMapOverview>;

export const mapSession = z
  .object({
    sessionId: id,
    taskId: id,
    mode: z.string().max(32),
    generation: z.number().int().min(1),
    ownership: z.enum(OWNERSHIP_STATE),
    seat: z.string().max(64).nullable(),
    seatRole: z.string().max(32).nullable(),
    /** Recorded creator. Set only when ownership is `recorded`. */
    parentSession: id.nullable(),
    /** Validated current manager; display only, never a recorded creator or adopted seat. */
    managedBy: id.nullable().optional(),
    /** The seat holder an operator adopted this session under. Set only when ownership is `adopted`. */
    adoptedUnder: id.nullable(),
    leaderChanged: z.boolean(),
    runtime: mapRuntime.nullable(),
  })
  .strict();
export type MapSession = z.infer<typeof mapSession>;

export const mapWorkstream = z
  .object({
    taskId: id,
    recorded: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    truncated: z.boolean(),
    sessions: z.array(mapSession).max(64),
  })
  .strict();
export type MapWorkstream = z.infer<typeof mapWorkstream>;

export const workMapProject = z
  .object({
    observedAt: z.string().datetime(),
    available: z.boolean(),
    unavailable: note.nullable(),
    projectId: id,
    name: z.string().max(160).nullable(),
    status: z.string().max(64).nullable(),
    membership: z
      .object({
        known: z.boolean(),
        partial: z.boolean(),
        truncated: z.boolean(),
        memberTaskCount: z.number().int().nonnegative(),
        note: note,
      })
      .strict()
      .nullable(),
    leader: mapSeat.nullable(),
    workstreams: z.array(mapWorkstream).max(64),
    needed: z.array(roleNeed).max(64),
    blockers: z.array(roleNeed).max(64),
    issues: linkedIssuesResult,
    note: note,
  })
  .strict();
export type WorkMapProject = z.infer<typeof workMapProject>;

export const workMapRpc = defineContract({
  name: "organization.work-map",
  input: z.object({}).strict(),
  output: workMapOverview,
});
export const workMapProjectRpc = defineContract({
  name: "organization.work-map-project",
  input: z.object({ projectId: id }).strict(),
  output: workMapProject,
});

/** The controller methods the work map may call. Nothing else may be added: every entry is a pure read. */
export const WORK_MAP_READS = ["bindings-status", "bindings-project", "channels-status"] as const;

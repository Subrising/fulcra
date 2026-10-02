import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
// J3 issue trackers — the contract J2's work graph and the project view consume (J3-DESIGN.md §6).
// No input anywhere names a repository, host or URL: the server derives all of them from the journal
// mapping of the Orca project. Every schema is strict, so an extra `repo`/`url`/`token` key is refused.
const id = z.string().uuid();
const tracker = z.enum(["github", "jira", "bitbucket"]);
export const trackerStatus = z.enum([
  "ok",
  "stale",
  "auth-required",
  "forbidden",
  "not-found",
  "rate-limited",
  "offline",
  "unmapped",
  "invalid-response",
  "error",
]);
export const trackerItemKey = z
  .string()
  .regex(/^(github|jira|bitbucket):[A-Za-z0-9._-]{1,64}:[A-Za-z0-9-]{1,32}$/);
const httpsUrl = z
  .string()
  .max(512)
  .regex(/^https:\/\/(github\.com|bitbucket\.org|[a-z0-9-]{1,63}\.atlassian\.net)\//);
const subject = z.object({ kind: z.enum(["session", "task"]), id }).strict();
export const trackersRpc = defineRpc({
  name: "organization.trackers",
  input: z.object({ projectId: id.optional(), subjects: z.array(id).max(64).optional() }).strict(),
  output: z
    .object({
      version: z.literal(1),
      observedAt: z.string().datetime(),
      partial: z.boolean(),
      projects: z
        .array(
          z
            .object({
              projectId: id,
              tracker: tracker.nullable(),
              remoteName: z.string().max(200).nullable(),
              mappingRevision: z.number().int().nonnegative(),
              status: trackerStatus,
              retryAt: z.string().datetime().nullable(),
              observedAt: z.string().datetime().nullable(),
            })
            .strict(),
        )
        .max(64),
      items: z
        .array(
          z
            .object({
              key: trackerItemKey,
              projectId: id,
              ref: z.string().max(40),
              title: z.string().max(256).nullable(),
              state: z.enum(["open", "closed", "unknown"]),
              labels: z.array(z.string().max(50)).max(8),
              url: httpsUrl,
              updatedAt: z.string().datetime().nullable(),
              stale: z.boolean(),
              fromPreviousMapping: z.boolean(),
            })
            .strict(),
        )
        .max(128),
      links: z
        .array(
          z
            .object({ id, itemKey: trackerItemKey, subject, revision: z.number().int().positive() })
            .strict(),
        )
        .max(256),
    })
    .strict(),
});
export type TrackerView = z.infer<typeof trackersRpc.output>;
const mapping = z
  .object({
    projectId: id,
    tracker,
    auth: z.enum(["keychain", "gh-cli"]),
    site: z.string().max(253),
    remoteId: z.string().max(64),
    remoteName: z.string().max(200),
    state: z.enum(["mapped", "unmapped"]),
    revision: z.number().int().nonnegative(),
    validatedAt: z.string().nullable(),
    note: z.string().max(500),
    at: z.string(),
  })
  .strict();
export const trackerDirectoryRpc = defineRpc({
  name: "organization.trackers.directory",
  input: z.object({}).strict(),
  output: z
    .object({
      available: z.boolean(),
      partial: z.boolean(),
      note: z.string().max(512),
      projects: z
        .array(
          z
            .object({
              id,
              name: z.string().max(160),
              mapping: mapping.nullable(),
              tasks: z.array(id).max(64),
              sessions: z.array(z.object({ id, task: id }).strict()).max(64),
            })
            .strict(),
        )
        .max(64),
    })
    .strict(),
});
const outcome = z.object({
  ok: z.boolean(),
  failure: z.union([trackerStatus, z.literal("refused")]).nullable(),
  message: z.string().max(300).nullable(),
});
const target = {
  tracker,
  auth: z.enum(["keychain", "gh-cli"]),
  site: z.string().max(253),
  remoteName: z.string().max(200),
};
export const trackerResolveRpc = defineRpc({
  name: "organization.trackers.resolve",
  input: z.object(target).strict(),
  output: outcome
    .extend({ remoteId: z.string().max(64).nullable(), remoteName: z.string().max(200).nullable() })
    .strict(),
});
// confirmRemoteId is the id the operator saw in the confirmation; the server refuses if it changed.
export const trackerMapRpc = defineRpc({
  name: "organization.trackers.map",
  input: z
    .object({
      projectId: id,
      ...target,
      confirmRemoteId: z.string().min(1).max(64),
      expectedRevision: z.number().int().nonnegative(),
      note: z.string().max(500),
    })
    .strict(),
  output: outcome.extend({ mapping: mapping.nullable() }).strict(),
});
export const trackerUnmapRpc = defineRpc({
  name: "organization.trackers.unmap",
  input: z
    .object({
      projectId: id,
      expectedRevision: z.number().int().positive(),
      note: z.string().max(500),
    })
    .strict(),
  output: outcome.extend({ mapping: mapping.nullable() }).strict(),
});
export const trackerLinkRpc = defineRpc({
  name: "organization.trackers.link",
  input: z
    .object({
      projectId: id,
      subject,
      itemRef: z.string().min(1).max(40),
      expectedMappingRevision: z.number().int().positive(),
    })
    .strict(),
  output: outcome
    .extend({ linkId: id.nullable(), revision: z.number().int().nonnegative().nullable() })
    .strict(),
});
export const trackerUnlinkRpc = defineRpc({
  name: "organization.trackers.unlink",
  input: z.object({ linkId: id, expectedRevision: z.number().int().positive() }).strict(),
  output: outcome
    .extend({ linkId: id.nullable(), revision: z.number().int().nonnegative().nullable() })
    .strict(),
});

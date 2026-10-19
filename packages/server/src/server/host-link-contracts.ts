import { z } from "zod";

const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const credential = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}\\.[A-Za-z0-9_-]{43}$`));
const lifetime = { expiresAt: z.number().finite(), revoked: z.boolean() };
export const HostLinkProfileSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_.:/-]+$/),
    modeId: name,
    parents: z.array(z.string().min(1).max(256)).min(1).max(32),
  })
  .strict();
export type HostLinkProfile = z.infer<typeof HostLinkProfileSchema>;
export const HostLinkConfigSchema = z
  .object({
    version: z.literal(1),
    machine: z.enum(["mac", "pc"]),
    chats: z
      .array(
        z
          .object({
            agentId: name,
            token: credential("hchat1"),
            ...lifetime,
            operations: z.array(z.enum(["spawn", "notice"])).max(2),
            links: z.array(name).max(32),
          })
          .strict(),
      )
      .max(256),
    outgoing: z
      .array(
        z
          .object({
            id: name,
            serverId: name,
            url: z.string().url(),
            token: credential("hlink1"),
            ...lifetime,
            machine: z.enum(["mac", "pc"]),
            reporters: z.array(name).max(256),
            shareLimits: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32),
    incoming: z
      .array(
        z
          .object({
            id: name,
            serverId: name,
            token: credential("hlink1"),
            ...lifetime,
            leads: z.array(name).max(256),
            operations: z.array(z.enum(["spawn", "notice", "limits"])).max(3),
            workloads: z.array(z.enum(["standard", "heavy", "gpu"])).max(3),
            workspaces: z.record(name, z.string().min(1).max(4096)),
            profiles: z.record(name, HostLinkProfileSchema),
            maxWorkers: z.number().int().min(0).max(100),
          })
          .strict(),
      )
      .max(32),
    routes: z
      .object({
        standard: name.optional(),
        heavy: name.optional(),
        gpu: name.optional(),
        mainAssistant: name.optional(),
      })
      .strict(),
  })
  .strict();
export type HostLinkConfig = z.infer<typeof HostLinkConfigSchema>;
export type IncomingHostLink = HostLinkConfig["incoming"][number];
export type OutgoingHostLink = HostLinkConfig["outgoing"][number];
export const HOST_LINK_RETENTION_MS = 30 * 86400000;
export const HOST_LINK_CLOCK_SKEW_MS = 5 * 60000;
const issuedAt = z.number().int().nonnegative();
const identity = { messageId: z.string().uuid() };
export const HostLinkSpawnSchema = z
  .object({
    kind: z.literal("spawn"),
    ...identity,
    issuedAt,
    workload: z.enum(["standard", "heavy", "gpu"]),
    workspace: name,
    profile: name,
    notifyOnFinish: z.boolean().optional(),
    expected: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1).optional(),
        modeId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    title: z.string().min(1).max(200),
    prompt: z.string().min(1).max(32000),
  })
  .strict();
export const HostLinkNoticeSchema = z
  .object({ kind: z.literal("notice"), ...identity, text: z.string().min(1).max(4000) })
  .strict();
export const HostLinkDispatchSchema = z.discriminatedUnion("kind", [
  HostLinkSpawnSchema,
  HostLinkNoticeSchema,
]);
export type HostLinkDispatch = z.infer<typeof HostLinkDispatchSchema>;
const origin = {
  destination: name,
  sender: name,
  sourceProvider: z.string().min(1).max(256),
  sourceMode: z.string().min(1).max(256),
};
export const HostAccountLimitSchema = z
  .object({
    accountId: z.string().uuid(),
    limitKind: z.enum(["session", "weekly"]),
    resetAt: z.string().datetime(),
    observedAt: z.string().datetime(),
  })
  .strict();
export type HostAccountLimit = z.infer<typeof HostAccountLimitSchema>;
export const RemoteAccountLimitSchema = HostAccountLimitSchema.extend({ source: name }).strict();
export const RemoteAccountLimitsSchema = z
  .object({ v: z.literal(1), observations: z.array(RemoteAccountLimitSchema).max(2048) })
  .strict();
export const HostAccountLimitWireSchema = HostAccountLimitSchema.extend({
  kind: z.literal("account_limit"),
  ...identity,
  destination: name,
}).strict();
const spawnWire = HostLinkSpawnSchema.extend(origin).strict();
const noticeWire = HostLinkNoticeSchema.extend({
  ...origin,
  noticeKind: z.enum(["explicit", "finished", "failed", "permission", "limit"]),
  isLead: z.boolean(),
}).strict();
export const HostLinkWireSchema = z.discriminatedUnion("kind", [
  HostAccountLimitWireSchema,
  spawnWire,
  noticeWire,
]);
// COMPAT(hostLinkIssuedAt): added v0.2.26; read legacy retained workers until 2027-04-19. Never replay timestamp-free pending requests.
const storedWire = z.discriminatedUnion("kind", [
  HostAccountLimitWireSchema,
  spawnWire.extend({ issuedAt: issuedAt.optional() }),
  noticeWire,
]);
export type HostLinkWire = z.infer<typeof HostLinkWireSchema>;
export type HostLinkNoticeKind = Extract<HostLinkWire, { kind: "notice" }>["noticeKind"];
export const HostLinkWorkerRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("prompt"),
      issuedAt,
      notifyOnFinish: z.boolean().optional(),
      steer: z.boolean().optional(),
      acknowledgedNoticeIds: z.array(name).max(128).optional(),
      ...identity,
      agentId: name,
      prompt: z.string().min(1).max(32000),
    })
    .strict(),
  z.object({ kind: z.literal("inspect"), agentId: name }).strict(),
  z.object({ kind: z.literal("notices"), agentId: name }).strict(),
  z
    .object({ kind: z.literal("acknowledge"), agentId: name, noticeIds: z.array(name).max(128) })
    .strict(),
]);
export type HostLinkWorkerRequest = z.infer<typeof HostLinkWorkerRequestSchema>;
export const HostLinkReceiptSchema = z
  .object({
    serverId: name,
    messageId: z.string().uuid(),
    state: z.enum([
      "pending",
      "created",
      "admitted",
      "delivered",
      "refused",
      "uncertain",
      "suppressed",
    ]),
    agentId: name.nullable(),
    token: credential("hworker1").nullable(),
    endpoint: z.string().url().nullable(),
  })
  .strict();
export type HostLinkReceipt = z.infer<typeof HostLinkReceiptSchema>;
export const HostLinkWorkerNoticeSchema = z
  .object({
    id: name,
    kind: z.enum(["finished", "failed", "permission"]),
    text: z.string().min(1).max(4000),
  })
  .strict();
export type HostLinkWorkerNotice = z.infer<typeof HostLinkWorkerNoticeSchema>;
export const HostLinkWorkerNoticesSchema = z
  .object({
    serverId: name,
    agentId: name,
    complete: z.boolean(),

    settledPromptIds: z.array(z.string().uuid()).max(128).optional(),
    notices: z.array(HostLinkWorkerNoticeSchema).max(128),
  })
  .strict();
export type HostLinkWorkerNotices = z.infer<typeof HostLinkWorkerNoticesSchema>;
const receivedNotice = HostLinkWorkerNoticeSchema.extend({
  state: z.enum(["queued", "sending", "delivered", "uncertain", "exhausted", "suppressed"]),
  attempts: z.number().int().min(0).max(8),
  nextAt: z.number().finite().nonnegative(),
}).strict();
export const HostLinkJournalSchema = z.record(
  z.string(),
  z
    .object({
      hash: z.string(),
      grant: z.string(),
      sender: name,
      linkId: name,
      sourceServerId: name,
      profile: HostLinkProfileSchema.nullable(),
      cwd: z.string().nullable(),
      receipt: HostLinkReceiptSchema,
      wire: storedWire.optional(),
      issuedAt: issuedAt.optional(),
      sourceSessionId: z.string().nullable().optional(),
      sourceGrant: z.string().optional(),
      noticeGrant: z.string().optional(),
      notifyOnFinish: z.boolean().optional(),
      promptRequest: z.boolean().optional(),
      generation: z.number().int().nonnegative().optional(),
      pendingPromptIds: z.array(z.string().uuid()).max(50).optional(),
      noticeTurnId: z.string().optional(),
      finishArmed: z.boolean().optional(),
      started: z.boolean().optional(),
      complete: z.boolean().optional(),
      notices: z
        .array(
          HostLinkWorkerNoticeSchema.extend({
            permissionRequestId: z.string().optional(),
            notBefore: z.number().finite().nonnegative().optional(),
            resolved: z.boolean().optional(),
          }).strict(),
        )
        .max(128)
        .optional(),
      receivedNotices: z.array(receivedNotice).max(128).optional(),
      watch: z
        .object({
          failures: z.number().int().min(0).max(8),
          nextAt: z.number().finite().nonnegative(),
        })
        .strict()
        .optional(),
    })
    .strict(),
);
export type HostLinkJournal = z.infer<typeof HostLinkJournalSchema>;

// Separate bounded replay records outlive the active worker journal.
export const HostLinkReplaySchema = z.record(
  z.string(),
  z
    .object({
      hash: z.string(),
      grant: z.string(),
      receipt: HostLinkReceiptSchema,
      retiredAt: z.number().finite(),
      credential: z.string(),
      noticeGrant: z.string(),
    })
    .strict(),
);

export const HostLinkCleanupSchema = z.object({ archived: z.boolean() }).strict();

export const HostLinkNoticeFailuresSchema = z.record(z.string(), z.literal(true));

import { z } from "zod";
import { defineContract } from "./rpc-contract";
const id = z.string().uuid();
const host = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
const projectRef = z.object({ serverId: host, projectId: z.string().min(1).max(1024) }).strict();
const contextRef = projectRef.extend({ workspaceId: z.string().min(1).max(1024) }).strict();
const primeRef = z
  .object({
    serverId: host,
    agentId: id,
    seat: z.string().min(1).max(64).nullable(),
    kind: z.enum(["recorded-prime", "human-session"]).optional(),
    label: z.string().max(160).optional(),
  })
  .strict();
const sessionRef = z
  .object({ serverId: host, agentId: id, workspaceId: z.string().min(1).max(1024) })
  .strict();
const project = z
  .object({
    key: z.string().max(2048),
    name: z.string().min(1).max(160),
    placements: z.array(projectRef).min(1).max(32),
    controllerProjectId: id.nullable(),
    preferredContext: contextRef.nullable(),
  })
  .strict();
const task = z
  .object({
    status: z.enum(["planned", "active", "blocked", "done"]).optional(),
    owner: primeRef.nullable().optional(),
    contexts: z.array(contextRef).max(64).optional(),
    controllerTaskId: id.nullable().optional(),
    id,
    projectKey: z.string().max(2048),
    title: z.string().min(1).max(160),
    kind: z.enum(["feature", "task"]),
    parentId: id.nullable(),
    sessions: z.array(sessionRef).max(128),
  })
  .strict();
const workspace = z
  .object({
    id,
    name: z.string().min(1).max(160),
    prime: primeRef.nullable(),
    lastProjectKey: z.string().max(2048).nullable().optional(),
    projects: z.array(project).max(128),
    tasks: z.array(task).max(512),
    at: z.string(),
  })
  .strict();
const conversation = contextRef
  .extend({
    deliveryId: id,
    agentId: id,
    state: z.enum(["pending", "created", "uncertain"]),
    projectKey: z.string().max(2048),
    at: z.string(),
  })
  .strict();
const intake = z
  .object({
    id,
    workspaceId: id,
    text: z.string().min(1).max(16384),
    prime: primeRef.nullable(),
    projectKey: z.string().max(2048).nullable(),
    context: contextRef.nullable(),
    state: z.string().max(64),
    basis: z.string().max(160).nullable(),
    primeRequest: z
      .object({
        id,
        state: z.string().max(64),
        prompt: z.string().max(16384).optional(),
        at: z.string(),
      })
      .strict()
      .nullable(),
    primeReply: z.string().max(16384).nullable(),
    conversations: z.array(conversation).max(64),
    history: z
      .array(
        z
          .object({
            projectKey: z.string().max(2048).nullable(),
            context: contextRef.nullable(),
            at: z.string(),
          })
          .strict(),
      )
      .max(64),
    at: z.string(),
  })
  .strict();
export const organizationState = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    companyId: id.optional(),
    companyName: z.string().min(1).max(160).nullable().optional(),
    defaultWorkspaceId: id.nullable().optional(),
    workspaces: z.array(workspace).max(64),
    intakes: z.array(intake).max(256),
  })
  .strict();
const base = { workspaceId: id };
export const organizationCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("name-company"), name: z.string().min(1).max(160) }).strict(),
  z.object({ ...base, action: z.literal("default-workspace") }).strict(),
  z
    .object({
      action: z.literal("create-workspace"),
      name: z.string().trim().min(1).max(160),
      prime: primeRef.nullable(),
    })
    .strict(),
  z.object({ ...base, action: z.literal("set-prime"), prime: primeRef.nullable() }).strict(),
  z
    .object({
      ...base,
      action: z.literal("add-project"),
      project: projectRef.extend({ name: z.string().min(1).max(160) }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("set-context"),
      projectKey: z.string().max(2048),
      context: contextRef,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("add-task"),
      projectKey: z.string().max(2048),
      title: z.string().min(1).max(160),
      kind: z.enum(["feature", "task"]),
      parentId: id.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("update-task"),
      taskId: id,
      status: z.enum(["planned", "active", "blocked", "done"]),
      owner: primeRef.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("link-session"),
      taskId: id,
      session: sessionRef,
      context: contextRef,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("begin-intake"),
      intakeId: id,
      text: z.string().min(1).max(16384),
      projectKey: z.string().max(2048).nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("route"),
      intakeId: id,
      projectKey: z.string().max(2048),
      context: contextRef,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("reserve-prime"),
      intakeId: id,
      requestId: id,
      prompt: z.string().min(1).max(16384),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("prime-result"),
      intakeId: id,
      requestId: id,
      state: z.enum(["answered", "held", "offline", "busy", "unavailable", "uncertain", "queued"]),
      reply: z.string().max(16384).nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("reserve-chat"),
      intakeId: id,
      deliveryId: id,
      agentId: id,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("chat-result"),
      intakeId: id,
      deliveryId: id,
      state: z.enum(["created", "uncertain"]),
      taskId: id.nullable(),
    })
    .strict(),
]);
export const organizationDirectoryRpc = defineContract({
  name: "organization.workspace.get_directory.request",
  input: z.object({}).strict(),
  output: organizationState,
});
export const organizationMutateRpc = defineContract({
  name: "organization.workspace.update.request",
  input: z
    .object({
      requestId: id,
      expectedRevision: z.number().int().nonnegative(),
      command: organizationCommand,
    })
    .strict(),
  output: organizationState,
});
export type OrganizationState = z.infer<typeof organizationState>;
export type OrganizationCommand = z.infer<typeof organizationCommand>;
export type WorkspaceUmbrella = OrganizationState["workspaces"][number];
export type OrganizationProject = WorkspaceUmbrella["projects"][number];
export type Intake = OrganizationState["intakes"][number];
export type ProjectReference = z.infer<typeof projectRef>;
export type ContextReference = z.infer<typeof contextRef>;

export const organizationReceiverRpc = defineContract({
  name: "organization.workspace.receiver.request",
  input: z.object({ prime: primeRef }).strict(),
  output: z
    .object({
      available: z.boolean(),
      reason: z.string().max(2000).nullable(),
      binding: z
        .object({
          sessionId: id,
          humanHeld: z.boolean().nullable(),
          session: z
            .object({ mode: z.string().max(32), generation: z.number().int().positive() })
            .strict()
            .nullable(),
          dispatch: z.object({ supported: z.boolean() }).strict(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

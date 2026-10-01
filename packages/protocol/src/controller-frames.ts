import { boundedControllerJson } from "./controller-service.js";
import { z } from "zod";
import { DaemonPermissionSchema } from "./messages.js";
import { type JsonValue } from "./trusted-input.js";
import type {
  ControllerHostRequestV11,
  ControllerHostReplyV11,
  ControllerChildCommandV11,
} from "./controller-management.js";

export class ControllerFrameError extends Error {
  readonly code: "invalid" | "expired" | "unauthorised" | "unavailable" | "uncertain";
  readonly publicMessage?: string;
  constructor(code: ControllerFrameError["code"], message?: string) {
    super(`Controller frame ${code}`);
    this.code = code;
    if (code === "invalid" && typeof message === "string" && message.length <= 2000)
      this.publicMessage = message;
  }
}
export function boundedJson(value: unknown): JsonValue {
  try {
    return boundedControllerJson(value);
  } catch {
    throw new ControllerFrameError("invalid");
  }
}
function parseFrame<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(boundedJson(value));
  } catch {
    throw new ControllerFrameError("invalid");
  }
}
export function controllerEnvelope(value: unknown): { id: string; epoch: string } | undefined {
  try {
    return z
      .object({ id: z.string().min(1).max(128), epoch: z.string().uuid() })
      .parse(boundedJson(value));
  } catch {
    return undefined;
  }
}
const id = z.string().min(1).max(128);
const envelope = { id, epoch: z.string().uuid() };
const binding = z
  .object({
    agentId: z.string().uuid(),
    kind: z.enum([
      "prompt",
      "steer",
      "replace",
      "cancel",
      "interrupt",
      "archive",
      "close",
      "rewind",
      "configure",
      "unarchive",
      "permission",
    ]),
    messageId: z.string().nullable(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().uuid(),
  })
  .strict();
const request = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("issue-provenance"), binding }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("daemon-rpc"),
      frame: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("report-inbox"),
      frame: z.record(z.string(), z.unknown()),
    })
    .strict(),
]);
const reply = z.discriminatedUnion("ok", [
  z.object({ ...envelope, ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ...envelope,
      ok: z.literal(false),
      code: z.enum(["unavailable", "unauthorised", "invalid", "expired", "uncertain"]),
      message: z.string().min(1).max(2000).optional(),
    })
    .strict(),
]);
const command = z
  .object({
    ...envelope,
    type: z.literal("management"),
    command: z.object({ method: z.string().min(1), input: z.unknown() }).strict(),
    principal: z
      .object({
        id,
        authentication: z.enum(["daemon-password", "paired-device", "protected-local-ipc"]),
        deviceId: z.string().nullable(),
        permissions: z.array(DaemonPermissionSchema),
      })
      .strict(),
  })
  .strict();
export function parseControllerRequest(value: unknown): ControllerHostRequestV11 {
  return parseFrame(request, value) as ControllerHostRequestV11;
}
export function parseControllerReply(value: unknown): ControllerHostReplyV11 {
  return parseFrame(reply, value) as ControllerHostReplyV11;
}
export function parseControllerCommand(value: unknown): ControllerChildCommandV11 {
  return parseFrame(command, value) as ControllerChildCommandV11;
}

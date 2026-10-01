import { z } from "zod";
import { canonicalJson, type JsonValue } from "./trusted-input.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";
// Host events include executable plugin bundles. Keep this separate from caller/management limits.
export const CONTROLLER_SERVICE_MAX_BYTES = 8 * 1024 * 1024;

/** Check depth before recursive schema/canonical processing. Never invoke getters. */
function checkJson(value: unknown, maxBytes = 1024 * 1024): JsonValue {
  let budget = maxBytes;
  const visit = (item: unknown, depth: number): void => {
    budget -= typeof item === "string" ? Buffer.byteLength(item) + 2 : 1;
    if (budget < 0) throw new Error("Frame too large");
    if (depth > 32) throw new Error("Frame too deep");
    if (item && typeof item === "object") {
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new Error("Invalid frame object");
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (Array.isArray(item) && key === "length") continue;
        budget -= Buffer.byteLength(key) + 3;
        if (!("value" in descriptor)) throw new Error("Invalid frame accessor");
        visit(descriptor.value, depth + 1);
      }
    }
  };
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maxBytes) throw new Error("Frame too large");
    value = JSON.parse(value);
  }
  // The complete envelope is level 1; scalar leaves count toward the boundary.
  visit(value, 1);
  const encoded = canonicalJson(value as JsonValue);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Frame too large");
  return JSON.parse(encoded) as JsonValue;
}
export function boundedControllerJson(value: unknown): JsonValue {
  return checkJson(value);
}

/** Only the embedding host's validated public service stream uses this larger bound. */
export function boundedControllerServiceJson(value: unknown): JsonValue {
  return checkJson(value, CONTROLLER_SERVICE_MAX_BYTES);
}
/** Owned-descriptor receive path: management/replies/boot retain the original 1 MiB limit. */
export function boundedControllerHostInput(input: unknown): JsonValue {
  const value = boundedControllerServiceJson(input);
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    typeof value.type === "string" &&
    ["daemon-open", "daemon-event", "daemon-closed"].includes(value.type)
  )
    return value;
  return boundedControllerJson(value);
}

export type ControllerServiceFrame =
  | { type: "daemon-open" | "daemon-event"; version: 1; epoch: string; frame: WSOutboundMessage }
  | { type: "daemon-closed"; version: 1; epoch: string };

/** Zod defaults may add fields, but no caller field may disappear during parsing. */
export function rejectUnknownControllerFields(input: unknown, parsed: unknown): void {
  if (!input || typeof input !== "object") return;
  if (!parsed || typeof parsed !== "object") throw Error("Invalid controller object");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(parsed, key)) throw Error("Unknown controller field");
    rejectUnknownControllerFields(Reflect.get(input, key), Reflect.get(parsed, key));
  }
}
export function parseControllerServiceFrame(input: unknown): ControllerServiceFrame {
  const value = boundedControllerServiceJson(input);
  const shape = z
    .discriminatedUnion("type", [
      z
        .object({
          type: z.literal("daemon-open"),
          version: z.literal(1),
          epoch: z.string().uuid(),
          frame: WSOutboundMessageSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("daemon-event"),
          version: z.literal(1),
          epoch: z.string().uuid(),
          frame: WSOutboundMessageSchema,
        })
        .strict(),
      z
        .object({
          type: z.literal("daemon-closed"),
          version: z.literal(1),
          epoch: z.string().uuid(),
        })
        .strict(),
    ])
    .parse(value);
  // The host already owns admission; public schemas intentionally normalize legacy fields.
  if (
    shape.type === "daemon-open" &&
    !(
      shape.frame.type === "session" &&
      shape.frame.message.type === "status" &&
      shape.frame.message.payload.status === "server_info"
    )
  )
    throw Error("Actual service welcome required");
  return shape;
}

import { exact, digest } from "./protocol.mjs";
import { uuid } from "../control/authority.mjs";
import { validateBookActivity } from "./activity.mjs";
import { validCursor, pageRequest } from "../../orca-organization/shared/history.mjs";
import { validateMessages } from "../../orca-organization/shared/work-messages.mjs";
export const validPageInput = (p) =>
  (exact(p, "cursor,sessionId,taskId") ||
    (exact(p, "cursor,includeMessages,sessionId,taskId") && p.includeMessages === true)) &&
  uuid(p.sessionId) &&
  uuid(p.taskId) &&
  (p.cursor === null || validCursor(p.cursor));
export function validateActivityPage(value, cwd, includeMessages = false) {
  if (
    !value ||
    !Object.hasOwn(value, "cursor") ||
    (value.cursor !== null && !validCursor(value.cursor))
  )
    throw Error("Invalid activity continuation");
  const { cursor, messages, ...rest } = value;
  validateBookActivity(rest, cwd);
  if (includeMessages) validateMessages(messages, rest.activity);
  else if (Object.hasOwn(value, "messages")) throw Error("Unexpected conversation excerpts");
  if (rest.hasOlder !== (cursor !== null)) throw Error("Activity continuation missing");
  return value;
}
export async function readBookPage(receiver, s, p) {
  if (!validPageInput(p) || p.taskId !== s.task) throw Error("Invalid activity page task");
  const before = await receiver.observed(s, true),
    binding = [
      receiver.controller,
      receiver.host,
      s.id,
      s.task,
      s.agent,
      before.nativeId,
      s.generation,
      s.mode,
      before.boot,
    ],
    scope = digest(p.includeMessages ? [...binding, "messages-v1"] : binding),
    request = pageRequest(p.cursor, scope);
  const projected = await receiver.native.activityPage(
      s.agent,
      s.cwd,
      request,
      scope,
      p.includeMessages === true,
    ),
    after = await receiver.observed(s, true),
    fresh = receiver.row(s.id);
  if (
    fresh.phase !== "created" ||
    fresh.cwd !== s.cwd ||
    fresh.task !== s.task ||
    fresh.agent !== s.agent ||
    fresh.generation !== s.generation ||
    fresh.mode !== s.mode ||
    before.boot !== after.boot ||
    before.nativeId !== after.nativeId ||
    before.humanAt !== after.humanAt ||
    before.lastUserAt !== after.lastUserAt
  )
    throw Error("Book activity identity changed during page");
  return validateActivityPage(
    {
      sessionId: s.id,
      taskId: s.task,
      agentId: s.agent,
      nativeId: after.nativeId ?? null,
      observedAt: after.observedAt,
      ...projected,
    },
    s.cwd,
    p.includeMessages === true,
  );
}

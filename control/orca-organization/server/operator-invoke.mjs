// Cutover A2: the conversation management route. Registered with the plugin's `handle` (index.server.ts), so every call
// already runs inside withManagementInvocation(ctx, false): the host hands ctx.management only to an admitted session whose
// principal holds command-centre.manage AND daemon.manage, one invocation per request, revoked when it settles. `false` is
// the readOnly flag: this handler may invoke write methods (a read handler may invoke only READ_METHODS).
//
// This handler adds exactly one check -- the method allowlist -- and otherwise passes the call through invokeManagement, the
// same path every other management RPC uses. It does not shape, default or pre-authorise the input: the controller's own
// schemas and grant/authority checks run at dispatch (src/control/rpc.mjs managementDispatcher -> rpc). Nothing is cached.
import { invokeManagement } from "./management-context.mjs";
import { OPERATOR_INVOKE_METHODS } from "../shared/operator-invoke-methods.mjs";
// Host codes that mean the controller never received the command (controller-channel / distribution-child pre-dispatch).
const NOT_DISPATCHED = new Set(["invalid", "expired", "unauthorised", "unavailable"]);
const text = (error) => String(error?.message ?? error).slice(0, 2000);
export async function operatorInvoke(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => k !== "method" && k !== "input") ||
    !OPERATOR_INVOKE_METHODS.includes(value.method)
  )
    return {
      ok: false,
      code: "not_allowed",
      dispatched: false,
      message: "Method not allowed on the conversation management route",
    };
  let pending;
  // A synchronous failure is before dispatch: no management invocation, or the command was refused before it was sent.
  try {
    pending = invokeManagement(value.method, value.input);
  } catch (error) {
    return {
      ok: false,
      code: error?.code === "management_unavailable" ? "management_unavailable" : "refused",
      dispatched: false,
      message: text(error),
    };
  }
  try {
    return { ok: true, result: await pending };
  } catch (error) {
    // Once handed to the host a write may have executed: only a host code proving it never reached the controller is a
    // refusal; everything else is uncertain and must not be replayed.
    const refused = NOT_DISPATCHED.has(error?.code);
    return {
      ok: false,
      code: refused ? error.code : "uncertain",
      dispatched: !refused,
      message: refused
        ? text(error)
        : "Management outcome uncertain; inspect before issuing another instruction. Do not replay.",
    };
  }
}

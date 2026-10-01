import { defineContract } from "./rpc-contract";
import { z } from "zod";
import { OPERATOR_INVOKE_METHODS, OPERATOR_INVOKE_RPC } from "./operator-invoke-methods.mjs";
// Cutover A2: the conversation client's writes through the authenticated management channel. The contract admits only
// the allowlisted method names; the input is NOT shaped here -- the controller's own schemas and authority checks
// decide it (server/operator-invoke.mjs). The reply says whether anything may have run.
export const operatorInvokeRpc = defineContract({ name: OPERATOR_INVOKE_RPC,
  input: z.object({ method: z.enum(OPERATOR_INVOKE_METHODS), input: z.unknown().optional() }).strict(),
  output: z.union([
    z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
    z.object({ ok: z.literal(false), code: z.string(), dispatched: z.boolean(), message: z.string() }).strict(),
  ]),
});

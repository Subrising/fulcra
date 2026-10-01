import { withManagementInvocation } from './management-context.mjs';
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { recoveryRpc, recoveryActionRpc, recoveryActionInput } from "../shared/recovery";
import { createRecovery } from "./recovery-handlers.mjs";
import { localCall } from "./management";
import { singleFlight } from "./tasks";
import { READ_DEADLINE_MS, withDeadline } from "./deadline";
// DESIGN-R R2. Registers the Recovery RPCs. Called once from index.server.ts; everything else lives in the
// dependency-free handlers so it is tested without the plugin toolchain.
export function contributeRecovery(server: PluginServerContext, authError: () => string | undefined, call = localCall, readDeadlineMs = READ_DEADLINE_MS): () => void {
  const recovery = createRecovery(call);
  // Review R F1: every open panel polls this, and one controller read touches the daemon, the task tracker and
  // git on a disk that stalls under fan-out. Coalesced exactly like readFleet: one read in flight, reused 10 s.
  let read: (() => ReturnType<typeof recovery.read>) | undefined;
  server.handle(recoveryRpc, async (_input, context) => withManagementInvocation(context, true, async () => { const e = authError(); if (e) return { status: "error" as const, message: e, observedAt: new Date().toISOString() }; read ??= singleFlight(() => recovery.read(), Date.now, 10000); const flight = read;
    // J6: answer before the host's 30 s timeout, in this surface's own error shape; the flight keeps running.
    return withDeadline(() => flight(), readDeadlineMs, recoveryRpc.name).catch(error => ({ status: "error" as const, message: (error as Error).message, observedAt: new Date().toISOString() })); }));
  // A write makes the coalesced read stale, so the next read after it goes to the controller.
  server.handle(recoveryActionRpc, async (input, context) => withManagementInvocation(context, false, async () => { const e = authError(); if (e) return { status: "error", message: e, observedAt: new Date().toISOString() }; const out = await recovery.act(recoveryActionInput.parse(input)); read = undefined; return out; }));
  return () => { read = undefined; };
}

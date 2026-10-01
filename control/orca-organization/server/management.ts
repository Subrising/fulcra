import { invokeManagement } from './management-context.mjs';
import { portable } from "./portable";
import { installationPath } from "./installation";
import fs from "node:fs";
import type { ContractOutput } from "../shared/rpc-contract";
import { readSupervisors } from "./supervisors";
import { managementInput, managementRpc, handoffSchema, type ManagementInput, taskManagementRpc } from "../shared/management";
export function controllerLocation(env: Record<string, string | undefined> = process.env) {
  const home = installationPath("controllerHome", env);
  if (fs.realpathSync(home) !== home || !fs.statSync(home).isDirectory()) throw Error("Canonical controller home required");
  return { home };
}

const TASK = (portable.programme);
type Row = { id: string; task: string; mode: "human" | "delegated"; generation: number };
type Result = ContractOutput<typeof managementRpc>;
type Call = (method: string, input?: unknown) => Promise<any>;
export function localCall(method: string, input?: unknown): Promise<any> {
  return Promise.resolve(invokeManagement(method, input));
}
export function createManagement(call: Call = localCall, now = () => new Date().toISOString(), task = TASK) {
  return async (value: ManagementInput): Promise<Result> => {
    const input = managementInput.parse(value), observedAt = now();
    const reply = (status: string, message: string, extra: Partial<Result> = {}): Result => ({ status, message, observedAt, ...extra });
    let effectiveId = "messageId" in input ? input.messageId : undefined;
    try {
      if (input.action === "health" || input.action === "retry-controller") {
        const state = await call(input.action === "health" ? "controller-status" : "controller-retry");
        if (state?.state !== "ready") return reply("error", `Controller ${state?.state ?? "unavailable"}. Retry when startup is complete, or restart Command Centre in Settings.`);
        await call("health"); return reply("observed", "Controller connection confirmed");
      }
      if (input.action === "create") {
        // Update-7 W3: an explicit model / effort is the per-spawn choice (a bare id is this provider's); left out, the role
        // default applies. The controller refuses one the provider does not list before anything is journaled.
        const model = input.model ? (input.model.includes("/") ? input.model : `${input.provider}/${input.model}`) : undefined;
        const defaults = model || input.effort ? { ...(model ? { model } : {}), ...(input.effort ? { thinkingOptionId: input.effort } : {}) } : undefined;
        const body = { taskId: task, provider: input.provider, title: input.title, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.role ? { role: input.role } : {}), ...(defaults ? { defaults } : {}) };
        effectiveId = await call("management-prepare", { kind: "create", body, messageId: input.messageId });
        const d = await call("create", { ...body, messageId: effectiveId });
        return reply(d.state, d.state === "delivered" ? "Session created under human control. Open it or explicitly delegate work." : "Creation is unconfirmed. Keep this delivery ID for reconciliation.", { messageId: effectiveId, ...(d.result?.id ? { sessionId: d.result.id } : {}) });
      }
      if (input.action === "recover" || input.action === "disposition" || input.action === "acknowledge") {
        const history: Array<{ id: string; state: string }> = await call("history", task);
        const allowed = input.action === "acknowledge" ? ["delivered", "refused", "abandoned"] : ["intent", "uncertain"];
        if (!history.some(r => r.id === input.messageId && allowed.includes(r.state))) throw new Error("Unresolved delivery not found in this task's recent history");
        if (input.action === "acknowledge") { await call("management-ack", input.messageId); return reply("acknowledged", "Delivery receipt acknowledged; this does not accept the work.", { messageId: effectiveId }); }
        const d = input.action === "recover" ? await call("recover", input.messageId) : await call("disposition", { messageId: effectiveId, reason: input.reason });
        return reply(d.state, ["resume", "leadership"].includes(d.kind) ? "The uncommitted organization handback was reconciled. Current authority was not changed and no instruction was sent." : input.action === "recover" ? "Reconciliation checked the native receipt or keyed creation. Refresh and inspect the result." : "Delivery abandoned; its outcome remains unverified. That identity will not be replayed.", { messageId: effectiveId });
      }
      const all: Row[] = await call("list"), enrolled = all.filter(r => r.task === task);
      if (input.action === "list") {
        const roles = await call("manager-summary");
        // U5-D04: entry by entry (server/supervisors.ts); one unreadable record never fails the whole list.
        const roleRead = readSupervisors(roles, 256);
        if (!roleRead.available) throw new Error("Invalid supervisor summary");
        const supervisors = roleRead.supervisors.filter(r => r.task === task && enrolled.some(s => s.id === r.id)).map(r => ({ ...r, workers: r.workers.filter(w => w.workerId === null || enrolled.some(s => s.id === w.workerId)) })).slice(0, 32);
        const leadership = await call("leadership-status");
        const handoffs = (leadership?.handoffs ?? []).filter((h: any) => enrolled.some(s => s.id === h.destination) && enrolled.some(s => s.id === h.source) && h.workers.every((id: string) => enrolled.some(s => s.id === id))).map((h: any) => { const { boot: _boot, grantedAt: _grantedAt, ...safe } = h; return handoffSchema.parse(safe); });
        const permissionState = await call("permissions-status");
        const permissions = (permissionState?.grants ?? []).filter((g: any) => enrolled.some(s => s.id === g.sessionId)).map((g: any) => ({ sessionId: g.sessionId, active: g.active, remaining: g.remaining, pool: g.pool, reason: g.reason.slice(0, 2000), pending: g.pending.length, recent: g.recent.map((r: any) => ({ id: r.id, state: r.state, note: String(r.result?.note ?? r.result?.verification ?? "").slice(0, 2000) })) }));
        return reply("observed", "Saved control modes; native runtime state is shown separately.", { sessions: enrolled.slice(0, 32).map(({ id, task, mode, generation }) => ({ id, task, mode, generation })), partial: enrolled.length > 32 || roleRead.issues.unreadable > 0, deliveries: await call("history", task), supervisors, supervisionIssues: roleRead.issues, handoffs, leadershipCapacity: leadership?.capacity, leadershipCandidates: (leadership?.candidates ?? []).filter((id: string) => enrolled.some(s => s.id === id)), leadershipError: null, permissions, permissionError: null });
      }
      const row = enrolled.find(r => r.id === input.sessionId);
      if (!row) throw new Error("Session is not enrolled for this task");
      if (input.action === "inspect") { const d = await call("observe", row.id); return reply("observed", `Control: ${d.mode}. Runtime: ${d.observed.status}. Pending permissions: ${d.observed.pending}. Recent deliveries: ${(d.deliveries ?? []).map((r: any) => `${r.id}: ${r.state}`).join("; ") || "none"}`, { sessionId: row.id }); }
      if (input.action === "takeover") { await call("takeover", { sessionId: row.id, reason: input.reason }); return reply("human", "Future delegated input revoked. Already delivered work may still be running.", { sessionId: row.id }); }
      if (row.generation !== input.generation) throw new Error("Control changed. Refresh before acting");
      if (input.action === "allow-routine" || input.action === "revoke-routine") {
        await call(input.action === "allow-routine" ? "permissions-grant" : "permissions-revoke", { sessionId: row.id, expectedGeneration: input.generation, reason: input.reason });
        return reply("observed", input.action === "allow-routine" ? "Routine Claude writes and exact edits enabled in owned task folders. The 100-response allowance is shared with newly created workers; existing workers need their own grant. Each result is checked before the next approval." : "Routine permission grant revoked. Already admitted tools may still finish.", { sessionId: row.id });
      }
      if (input.action === "leadership") {
        if (!enrolled.some(s => s.id === input.destinationId && s.generation === input.destinationGeneration) || input.workers.some(w => !enrolled.some(s => s.id === w.sessionId && s.generation === w.expectedGeneration))) throw new Error("Destination or worker control changed");
        const body = { sessionId: row.id, expectedGeneration: input.generation, destinationId: input.destinationId, destinationGeneration: input.destinationGeneration, maxWorkers: input.maxWorkers, context: input.context, workers: [...input.workers].sort((a, b) => a.sessionId.localeCompare(b.sessionId)) };
        effectiveId = await call("management-prepare", { kind: "leadership", body, messageId: input.messageId });
        const d = await call("leadership-transfer", { ...body, messageId: effectiveId });
        return reply(d.state, d.state === "delivered" ? "Leadership transferred with existing workers. Handoff delivery and consumption are shown separately below." : `Leadership ${d.state}: ${d.result?.error ?? d.result?.note ?? "inspect the receipt"}`, { messageId: effectiveId, sessionId: d.result?.sessionId ?? row.id });
      }
      if (input.action === "resume") {
        const workers = [...input.workers].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        if (workers.some(w => !enrolled.some(s => s.id === w.sessionId && s.generation === w.expectedGeneration))) throw new Error("Selected worker changed or belongs to another task");
        const body = { sessionId: row.id, expectedGeneration: input.generation, workers, reason: input.reason };
        effectiveId = await call("management-prepare", { kind: "resume", body, messageId: input.messageId });
        const d = await call("manager-resume", { ...body, messageId: effectiveId });
        return reply(d.state, d.state === "delivered" ? "Selected delegation restored. Send the supervisor an instruction to continue; no earlier work was replayed." : d.state === "refused" ? `Handback was not committed: ${d.result?.error ?? d.result?.note ?? "inspect the receipt"}` : "Handback outcome is unconfirmed. Reconcile this receipt before trying again.", { messageId: effectiveId, sessionId: row.id });
      }
      if (input.action === "supervise") {
        await call("manager-promote", { sessionId: row.id, expectedGeneration: input.generation, maxWorkers: input.maxWorkers, reason: input.reason });
        return reply("supervisor", "Supervisor delegated. Send its outcome here; it can create and direct workers within its allowance. Previous orphaned workers are not resumed.", { sessionId: row.id });
      }
      if (input.action === "handback") {
        await call("handback", { sessionId: row.id, reason: input.reason, expectedGeneration: input.generation });
        return reply("delegated", "Delegated. You can send work below; typing or stopping in the native conversation takes control back.", { sessionId: row.id });
      }
      if (row.mode !== "delegated") throw new Error("Explicit delegation is required before assigning work");
      if (Buffer.byteLength(input.text) > 16384) throw new Error("Instruction exceeds UTF-8 limit");
      const body = { sessionId: row.id, expectedGeneration: input.generation, text: input.text };
      effectiveId = await call("management-prepare", { kind: "send", body, messageId: input.messageId });
      const d = await call("operator-send", { ...body, messageId: effectiveId });
      return reply(d.state, d.state === "delivered" ? "Native delivery acknowledged. Follow the conversation for work, review and acceptance." : `Delivery ${d.state}. Inspect before issuing another instruction.`, { messageId: effectiveId, sessionId: row.id });
    } catch (error) { const uncertain = error instanceof Error && Reflect.get(error, "code") === "uncertain"; return reply(uncertain ? "uncertain" : "error", uncertain ? "Management outcome uncertain; do not replay. Reconcile the delivery receipt." : error instanceof Error ? error.message : "Control unavailable", "messageId" in input ? { messageId: effectiveId } : {}); }
  };
}

// Read/revoke paths remain available when current task authority cannot grant new work.
export function createTaskManagement(call: Call = localCall, check: (id: string) => Promise<unknown> = async id => { const result = await call("task-authority", id); if (result?.allowed !== true) throw new Error("Task authority unavailable"); }, now = () => new Date().toISOString()) {
  return async (value: unknown): Promise<ContractOutput<typeof taskManagementRpc>> => {
    const { taskId, command } = taskManagementRpc.input.parse(value);
    if (["health", "retry-controller", "inspect", "takeover", "revoke-routine", "acknowledge", "disposition"].includes(command.action)) return createManagement(call, now, taskId)(command);
    let taskAuthority = { allowed: true, error: null as string | null };
    try { await check(taskId); } catch (error) { taskAuthority = { allowed: false, error: error instanceof Error ? error.message.slice(0, 512) : "Task authority unavailable" }; }
    if (!taskAuthority.allowed && command.action !== "list") return { status: "error", message: "Task authority inactive. Inspect, take control, revoke permissions or abandon an unresolved receipt; no new work was sent.", observedAt: now(), taskAuthority };
    return { ...await createManagement(call, now, taskId)(command), taskAuthority };
  };
}

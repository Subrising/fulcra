import { readFile, stat, realpath } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProjectDispatch, DispatchApproval } from "@getpaseo/protocol/project-dispatch";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import { formatProviderModel } from "../agent/create-agent/create.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { FINAL_INPUT_CHECK } from "../agent/agent-sdk-types.js";
import { createFinalInputCheck } from "../agent/final-input-check.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { reportsTo, type LineAgent } from "../reporting-lines.js";
import {
  parseDispatchRows,
  dispatchRowDigest,
  dispatchPrompt,
  ledgerTransaction,
  ledgerLease,
  type LedgerLease,
  type DispatchRow,
} from "./ledger.js";
export { parseDispatchRows, dispatchRowDigest, dispatchPrompt } from "./ledger.js";

const ResultSchema = z.object({ state: z.enum(["DONE", "BLOCKED", "DECISION"]), line: z.string() });
export type WorkerResult = z.infer<typeof ResultSchema>;
export function parseWorkerResult(text: string | null | undefined): WorkerResult | null {
  const line = text?.trim().split(/\r?\n/).at(-1)?.trim();
  const match = line?.match(
    /^(?:\*\*|__|`)?(DONE|BLOCKED|DECISION)(?:\*\*|__|`)?(?:(?:\s*[:.\-–—]\s*|\s+)(.*))?$/,
  );
  if (!match || (match[1] !== "DONE" && !match[2])) return null;
  return ResultSchema.parse({
    state: match[1],
    line: `${match[1]}${match[2] ? ` ${match[2]}` : ""}`,
  });
}
const ClaimSchema = z.object({
  project: z.string(),
  item: z.string(),
  role: z.string(),
  sessionId: z.string(),
  operationId: z.string(),
  generation: z.string(),
  cwd: z.string(),
  at: z.number(),
  ledgerSettled: z.boolean().default(false),
  stage: z.enum([
    "reserved",
    "creating",
    "created",
    "sending",
    "started",
    "uncertain",
    "closed",
    "abandoned",
  ]),
});
type Claim = z.infer<typeof ClaimSchema>;
const EndSchema = z.object({
  project: z.string(),
  item: z.string(),
  generation: z.string(),
  eventId: z.string(),
  result: ResultSchema.nullable(),
});
const StateSchema = z.object({
  version: z.literal(2),
  claims: z.array(ClaimSchema),
  ends: z.record(z.string(), EndSchema),
  notices: z.array(z.string()),
});
type RoutingState = z.infer<typeof StateSchema>;
interface RoutingDeps {
  statePath: string;
  ledgerDir: string;
  hostId: string;
  daemonHome: string;
  enabled: () => boolean;
  config: () => Record<string, ProjectDispatch>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  ensureWorkspace: (cwd: string) => Promise<string>;
  logger: Logger;
  notify: (lead: string, line: string, messageId: string) => Promise<void>;
  now?: () => number;
}
const terminal = (claim: Claim) => claim.stage === "closed" || claim.stage === "abandoned";
const MAX_ACTIVE = 16;

export class LedgerRoutingService {
  private state: RoutingState;
  private lane: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private lease?: LedgerLease;
  constructor(private readonly deps: RoutingDeps) {
    try {
      const raw: unknown = JSON.parse(readFileSync(deps.statePath, "utf8"));
      const old = z
        .object({
          version: z.literal(1),
          claims: z.array(
            z.object({
              project: z.string(),
              item: z.string(),
              role: z.string(),
              sessionId: z.string().nullable(),
              operationId: z.string(),
            }),
          ),
        })
        .safeParse(raw);
      this.state = old.success
        ? {
            version: 2,
            claims: old.data.claims.map((c) => ({
              project: c.project,
              item: c.item,
              role: c.role,
              operationId: c.operationId,
              sessionId: c.sessionId ?? randomUUID(),
              generation: "legacy",
              cwd: "",
              at: 0,
              ledgerSettled: false,
              stage: "uncertain",
            })),
            ends: {},
            notices: [],
          }
        : StateSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 2, claims: [], ends: {}, notices: [] };
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.lease?.close();
  }
  enabledForLead(id: string): boolean {
    return (
      this.deps.enabled() &&
      Object.values(this.deps.config()).some((c) => c.enabled && c.leadId === id)
    );
  }
  tracks(worker: LineAgent): boolean {
    return this.binding(worker) !== null;
  }
  private save(): void {
    const active = this.state.claims.filter((c) => !terminal(c) || !c.ledgerSettled);
    const history = this.state.claims.filter((c) => terminal(c) && c.ledgerSettled).slice(-128);
    this.state.claims = [...history, ...active];
    const live = new Set(active.map((c) => c.sessionId));
    const ends = Object.entries(this.state.ends)
      .filter(([id]) => live.has(id))
      .slice(-128);
    this.state.ends = Object.fromEntries(ends);
    this.state.notices = this.state.notices.slice(-128);
    writePrivateFileAtomicSync(this.deps.statePath, JSON.stringify(this.state), { durable: true });
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lane.then(run);
    this.lane = result.catch((err: unknown) =>
      this.deps.logger.warn({ err }, "Ledger routing failed"),
    );
    return result;
  }
  private binding(worker: LineAgent): Claim | null {
    if (worker.archivedAt) return null;
    return (
      this.state.claims.find(
        (c) =>
          !terminal(c) &&
          c.sessionId === worker.id &&
          c.item === worker.labels?.["fulcra.item"] &&
          c.project === worker.labels?.["fulcra.project"] &&
          c.generation === worker.labels?.["fulcra.item-generation"] &&
          c.operationId === worker.labels?.["fulcra.dispatch-id"] &&
          reportsTo(worker) === this.deps.config()[c.project]?.leadId,
      ) ?? null
    );
  }
  observeEnd(input: {
    worker: LineAgent;
    eventId: string;
    text: string | null;
    failed: boolean;
    fromNotice: boolean;
  }): Promise<{ result: WorkerResult | null; fresh: boolean } | null> {
    return this.enqueue(async () => {
      if (this.stopped || input.fromNotice) return null;
      const claim = this.binding(input.worker);
      if (!claim) return null;
      const prior = this.state.ends[input.worker.id];
      if (prior?.eventId === input.eventId) return { result: prior.result, fresh: false };
      const result = input.failed ? null : parseWorkerResult(input.text);
      this.state.ends[input.worker.id] = {
        project: claim.project,
        item: claim.item,
        generation: claim.generation,
        eventId: input.eventId,
        result,
      };
      this.save();
      await this.dispatch();
      return { result, fresh: true };
    });
  }
  begin(worker: LineAgent): void {
    const claim = this.binding(worker);
    if (!claim || this.stopped) return;
    this.state.ends[worker.id] = {
      project: claim.project,
      item: claim.item,
      generation: claim.generation,
      eventId: randomUUID(),
      result: null,
    };
    this.save();
  }
  wake(): Promise<void> {
    return this.enqueue(() => this.dispatch());
  }
  changed(): Promise<void> {
    return this.wake();
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private async rows(project: string): Promise<DispatchRow[]> {
    const file = path.join(this.deps.ledgerDir, project, "OPEN-ITEMS.md");
    if ((await stat(file)).size > 512 * 1024) throw new Error("Ledger exceeds its size limit");
    return parseDispatchRows(await readFile(file, "utf8"));
  }
  private held(agent: LineAgent, config: ProjectDispatch): boolean {
    const labels = agent.labels ?? {};
    return Boolean(
      labels["fulcra.hold"]?.trim() ||
      labels["fulcra.dispatch"] === "off" ||
      config.holdLabels.some((l) => labels[l]?.trim()),
    );
  }
  private abandoned(agent: LineAgent | undefined): boolean {
    if (!agent || agent.archivedAt) return true;
    if (agent.labels?.["fulcra.dispatch-state"] !== "abandoned") return false;
    return (
      !this.deps.agentManager.hasInFlightRun(agent.id) &&
      this.deps.agentManager.getAgent(agent.id)?.lifecycle !== "running"
    );
  }
  private released(claim: Claim, rows: readonly DispatchRow[]): boolean {
    const end = this.state.ends[claim.sessionId];
    if (
      end?.result?.state !== "DONE" ||
      end.item !== claim.item ||
      end.generation !== claim.generation ||
      end.project !== claim.project
    )
      return false;
    return rows.some(
      (r) =>
        r.id === claim.item &&
        r.status === "DONE" &&
        r.evidence.length >= 3 &&
        !/^(?:—|-|none|n\/a)$/i.test(r.evidence),
    );
  }
  private busy(claim: Claim, agents: readonly LineAgent[]): boolean {
    const agent = agents.find((a) => a.id === claim.sessionId);
    if (terminal(claim) || (agent && this.abandoned(agent))) return false;
    if (claim.stage === "uncertain") return this.deps.agentManager.hasInFlightRun(claim.sessionId);
    return true;
  }
  private hostMatches(config: ProjectDispatch): boolean {
    let root: string;
    try {
      root = realpathSync(this.deps.ledgerDir);
      realpathSync(config.daemonHome);
      realpathSync(config.ledgerRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    return (
      config.hostId === this.deps.hostId &&
      realpathSync(config.daemonHome) === realpathSync(this.deps.daemonHome) &&
      realpathSync(config.ledgerRoot) === root &&
      !/(?:^|\/)ledger\/mirror(?:\/|$)/.test(root)
    );
  }
  private async notice(config: ProjectDispatch, key: string, line: string): Promise<void> {
    if (this.state.notices.includes(key)) return;
    this.state.notices.push(key);
    this.save();
    // Notice delivery cannot hold the event lane. The receipt ID prevents another model wake.
    void this.deps
      .notify(config.leadId, line, `paseo-notify:ledger:${key}`)
      .catch((err: unknown) => this.deps.logger.warn({ err }, "Ledger routing notice refused"));
  }
  private async settle(
    claim: Claim,
    stage: "closed" | "abandoned" | "uncertain",
    reason?: string,
  ): Promise<void> {
    claim.stage = stage;
    delete this.state.ends[claim.sessionId];
    this.save();
    try {
      const result = await ledgerTransaction({
        action: "abandon",
        root: this.deps.ledgerDir,
        project: claim.project,
        item: claim.item,
        operationId: claim.operationId,
      });
      claim.ledgerSettled = result.ok;
      this.save();
    } catch (err) {
      this.deps.logger.warn(
        { err, item: claim.item },
        "Ledger claim settlement needs another event",
      );
    }
    const config = this.deps.config()[claim.project];
    if (reason && config)
      await this.notice(
        config,
        claim.operationId,
        `BLOCKED ${claim.item}: ${reason}. Inspect session ${claim.sessionId}.`,
      );
  }
  private async reconcile(agents: readonly LineAgent[]): Promise<void> {
    for (const claim of this.state.claims) {
      const agent = agents.find(
        (a) => a.id === claim.sessionId || a.labels?.["fulcra.dispatch-id"] === claim.operationId,
      );
      if (agent && this.abandoned(agent)) {
        await this.settle(claim, "abandoned");
        continue;
      }
      const config = this.deps.config()[claim.project];
      if (!config || !this.hostMatches(config)) continue;
      if (terminal(claim)) {
        if (!claim.ledgerSettled)
          await this.settle(claim, claim.stage === "closed" ? "closed" : "abandoned");
        continue;
      }
      if (claim.generation === "legacy") {
        await this.settle(claim, "abandoned", "legacy claim needs current owner approval");
        continue;
      }
      if (!agent) {
        await this.settle(claim, "abandoned");
        continue;
      }
      if (claim.stage === "started") {
        if (this.released(claim, await this.rows(claim.project)))
          await this.settle(claim, "closed");
        continue;
      }
      if (claim.stage === "uncertain" && this.deps.agentManager.hasInFlightRun(claim.sessionId))
        continue;
      claim.sessionId = agent.id;
      if (claim.stage === "sending" || claim.stage === "uncertain") {
        await ensureUnarchivedAgentLoaded(agent.id, { ...this.deps });
        if (
          this.deps.agentManager.hasSubmittedFinishMessageNow(
            agent.id,
            `ledger-dispatch:${claim.operationId}`,
          )
        ) {
          claim.stage = "started";
          this.save();
          continue;
        }
      }
      // No provider input is replayed after an uncertain handoff. Free the slot and expose the blocked item.
      await this.settle(
        claim,
        "abandoned",
        "interrupted start needs owner approval before another attempt",
      );
    }
    this.save();
  }
  private assertAccount(id: string, wanted: string): void {
    const account = this.deps.agentManager.getAgentUsageCredential(id);
    if (!account?.isCurrent() || account.label?.toLowerCase() !== wanted.toLowerCase())
      throw new Error("Requested dispatch account unavailable");
  }
  private async recoverLedgerClaims(agents: readonly LineAgent[]): Promise<void> {
    for (const [project, config] of Object.entries(this.deps.config())) {
      if (!this.hostMatches(config)) continue;
      for (const row of await this.rows(project)) {
        const operation = /^IN PROGRESS: dispatch ([a-f0-9-]{36})$/.exec(row.status)?.[1];
        if (!operation || this.state.claims.some((c) => c.operationId === operation)) continue;
        const receipt = await ledgerTransaction({
          action: "receipt",
          root: this.deps.ledgerDir,
          project,
          item: row.id,
          operationId: operation,
        });
        if (!receipt.ok || !receipt.sessionId || !receipt.generation) continue;
        const agent = agents.find(
          (a) => a.id === receipt.sessionId && a.labels?.["fulcra.dispatch-id"] === operation,
        );
        this.state.claims.push({
          project,
          item: row.id,
          role: agent?.labels?.["fulcra.role"] ?? "unknown",
          sessionId: receipt.sessionId,
          operationId: operation,
          generation: receipt.generation,
          cwd: config.approvals[row.id]?.cwd ?? "",
          at: this.now(),
          ledgerSettled: false,
          stage: "uncertain",
        });
      }
    }
    this.save();
  }
  private async dispatch(): Promise<void> {
    if (this.stopped) return;
    const local = Object.values(this.deps.config()).some((c) => c.enabled && this.hostMatches(c));
    if (!local) {
      await this.lease?.close();
      this.lease = undefined;
      return;
    }
    if (this.lease && !this.lease.alive()) {
      await this.lease.close();
      this.lease = undefined;
    }
    this.lease ??= ledgerLease(this.deps.ledgerDir);
    if (!(await this.lease.ready)) {
      await this.lease.close();
      this.lease = undefined;
      return;
    }
    if (this.stopped) return;
    const agents = await this.deps.agentStorage.list();
    await this.recoverLedgerClaims(agents);
    await this.reconcile(agents);
    if (!this.deps.enabled()) return;
    for (const [project, config] of Object.entries(this.deps.config())) {
      if (!config.enabled) continue;
      try {
        if (this.hostMatches(config)) await this.dispatchProject(project, config);
      } catch (err) {
        this.deps.logger.warn({ err, project }, "Ledger routing project unavailable");
      }
    }
  }
  private async dispatchProject(project: string, config: ProjectDispatch): Promise<void> {
    const agents = await this.deps.agentStorage.list();
    const lead = agents.find((a) => a.id === config.leadId);
    if (!lead || lead.archivedAt || this.held(lead, config)) return;
    let active = this.state.claims.filter(
      (c) => c.project === project && this.busy(c, agents),
    ).length;
    for (const row of await this.rows(project)) {
      const total = this.state.claims.filter((c) =>
        this.busy(c, this.deps.agentStorage.listCached()),
      ).length;
      if (this.stopped || active >= config.maxParallel || total >= MAX_ACTIVE) break;
      const selected = this.select(row, config, project);
      if (!selected) continue;
      const { role, approval } = selected;
      const started = await this.start(project, config, role, row, approval);
      if (!started) break;
      active++;
    }
  }
  private select(
    row: DispatchRow,
    config: ProjectDispatch,
    project: string,
  ): { role: ProjectDispatch["roles"][number]; approval: DispatchApproval } | null {
    const approval = config.approvals[row.id];
    const role = config.roles.find((r) => r.owner === row.owner);
    if (!role || row.status !== "READY" || !["BUILD", "FIX"].includes(row.kind) || !approval)
      return null;
    if (approval.addedBy !== "owner" && approval.addedBy !== config.leadId) return null;
    if (
      approval.digest !== dispatchRowDigest(row) ||
      row.source.includes(`[fulcra-dispatch:${approval.generation}:`)
    )
      return null;
    if (
      this.state.claims.some(
        (c) => c.project === project && c.item === row.id && c.generation === approval.generation,
      )
    )
      return null;
    return { role, approval };
  }
  private async start(
    project: string,
    config: ProjectDispatch,
    role: ProjectDispatch["roles"][number],
    row: DispatchRow,
    approval: DispatchApproval,
  ): Promise<boolean> {
    const cwd = await realpath(approval.cwd);
    const allApprovals = Object.entries(this.deps.config()).flatMap(([p, c]) =>
      Object.entries(c.approvals)
        .filter(([id]) => p !== project || id !== row.id)
        .map(([, a]) => a.cwd),
    );
    for (const directory of allApprovals) {
      let other: string;
      try {
        other = await realpath(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (other === cwd) throw new Error("Each approved item needs a separate directory");
    }
    if (
      this.state.claims.some((c) => c.cwd === cwd && (c.project !== project || c.item !== row.id))
    )
      throw new Error("A different dispatched item already owns this directory");
    const plan = dispatchPlan(config, row.id, row.owner);
    const claim: Claim = {
      project,
      item: row.id,
      role: role.role,
      sessionId: randomUUID(),
      operationId: randomUUID(),
      generation: approval.generation,
      cwd,
      at: this.now(),
      ledgerSettled: false,
      stage: "reserved",
    };
    const check = (prepared?: AgentSessionConfig) => {
      const current = this.deps.config()[project];
      const lead = this.deps.agentStorage.getCached(config.leadId);
      if (
        this.stopped ||
        !this.lease?.alive() ||
        !this.deps.enabled() ||
        !current?.enabled ||
        !this.hostMatches(current) ||
        dispatchPlan(current, row.id, row.owner) !== plan ||
        !lead ||
        lead.archivedAt ||
        this.held(lead, current)
      )
        throw new Error("Dispatch admission changed");
      if (prepared) assertPrepared(prepared, role, cwd);
      if (["created", "sending", "started"].includes(claim.stage))
        this.assertAccount(claim.sessionId, role.account);
      const worker = this.deps.agentStorage.getCached(claim.sessionId);
      if (worker && (worker.archivedAt || this.held(worker, current)))
        throw new Error("Dispatch worker held");
    };
    check();
    const response = await ledgerTransaction({
      action: "claim",
      root: this.deps.ledgerDir,
      project,
      item: row.id,
      digest: approval.digest,
      generation: approval.generation,
      addedBy: approval.addedBy,
      operationId: claim.operationId,
      sessionId: claim.sessionId,
      now: this.now(),
      enableId: config.enableId,
      maxParallel: config.maxParallel,
      maxTotalStarts: config.maxTotalStarts,
      dailyStartBudget: config.dailyStartBudget,
      minStartIntervalSeconds: config.minStartIntervalSeconds,
    });
    if (!response.ok) {
      if (/limit|budget|consumed/.test(response.reason ?? ""))
        await this.notice(
          config,
          `${project}:${config.enableId}:${new Date(this.now()).toISOString().slice(0, 10)}:${response.reason}`,
          `BLOCKED ${project}: ${response.reason}. Owner approval is required to increase the allowance.`,
        );
      return false;
    }
    this.state.claims.push(claim);
    this.save();
    try {
      check();
      await ensureUnarchivedAgentLoaded(config.leadId, { ...this.deps });
      check();
      const workspaceId = await this.deps.ensureWorkspace(cwd);
      check();
      const latest = (await this.rows(project)).find((r) => r.id === row.id);
      if (latest?.status !== `IN PROGRESS: dispatch ${claim.operationId}`)
        throw new Error("Ledger claim changed");
      claim.stage = "creating";
      this.save();
      const created = await this.deps.agentManager.trustedPlugins.daemon(() =>
        this.deps.createAgent({
          kind: "mcp",
          agentId: claim.sessionId,
          provider: formatProviderModel(role.provider, role.model),
          title: row.id,
          cwd,
          workspaceId,
          mode: role.mode,
          thinking: role.thinking,
          env: { FULCRA_ACCOUNT_REQUEST: role.account },
          callerAgentId: config.leadId,
          background: true,
          notifyOnFinish: false,
          creationAdmission: check,
          labels: {
            "fulcra.project": project,
            "fulcra.role": role.role,
            "fulcra.item": row.id,
            "fulcra.item-generation": approval.generation,
            "fulcra.reports-to": config.leadId,
            "fulcra.dispatch-id": claim.operationId,
            "fulcra.added-by": approval.addedBy,
          },
          onCreated: () => {
            claim.stage = "created";
            this.save();
          },
        }),
      );
      check();
      this.assertAccount(claim.sessionId, role.account);
      await this.deps.agentStorage.armFinishNotice(created.snapshot, config.leadId, "report-up");
      claim.stage = "sending";
      this.save();
      await this.deps.agentManager.trustedPlugins.daemon(() =>
        sendPromptToAgent({
          agentManager: this.deps.agentManager,
          agentStorage: this.deps.agentStorage,
          agentId: claim.sessionId,
          prompt: dispatchPrompt(row, approval.addedBy),
          messageId: `ledger-dispatch:${claim.operationId}`,
          unarchive: false,
          runOptions: { [FINAL_INPUT_CHECK]: createFinalInputCheck(check) },
          logger: this.deps.logger,
        }),
      );
      claim.stage = "started";
      this.save();
      return true;
    } catch (err) {
      const unknown = claim.stage === "sending" || claim.stage === "creating";
      await this.settle(
        claim,
        unknown ? "uncertain" : "abandoned",
        err instanceof Error ? err.message : "dispatch failed",
      );
      return false;
    }
  }
}

function dispatchPlan(config: ProjectDispatch, item: string, owner: string): string {
  return JSON.stringify({
    enableId: config.enableId,
    leadId: config.leadId,
    approval: config.approvals[item],
    role: config.roles.find((role) => role.owner === owner),
    maxParallel: config.maxParallel,
    maxTotalStarts: config.maxTotalStarts,
    dailyStartBudget: config.dailyStartBudget,
    minStartIntervalSeconds: config.minStartIntervalSeconds,
  });
}
function assertPrepared(
  prepared: AgentSessionConfig,
  role: ProjectDispatch["roles"][number],
  cwd: string,
): void {
  if (
    prepared.provider !== role.provider ||
    prepared.model !== role.model ||
    prepared.modeId !== role.mode ||
    prepared.cwd !== cwd
  )
    throw new Error("Dispatch template changed during preparation");
}

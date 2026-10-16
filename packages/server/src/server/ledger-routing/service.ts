import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProjectDispatch } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { formatProviderModel } from "../agent/create-agent/create.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { FINAL_INPUT_CHECK } from "../agent/agent-sdk-types.js";
import { createFinalInputCheck } from "../agent/final-input-check.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { isLedgerRowReady } from "../ledger-items.js";
import { reportsTo, type LineAgent } from "../reporting-lines.js";

const ResultSchema = z.object({
  state: z.enum(["DONE", "BLOCKED", "DECISION"]),
  line: z.string(),
});
export type WorkerResult = z.infer<typeof ResultSchema>;

export function parseWorkerResult(text: string | null | undefined): WorkerResult | null {
  const line = text?.trim().split(/\r?\n/).at(-1)?.trim();
  const match = line?.match(/^(DONE|BLOCKED|DECISION)(?:\s+(.+))?$/);
  if (!match || (match[1] !== "DONE" && !match[2])) return null;
  return ResultSchema.parse({ state: match[1], line });
}

interface DispatchRow {
  id: string;
  brief: string;
  kind: string;
  owner: string;
  status: string;
  evidence: string;
}

export function parseDispatchRows(text: string): DispatchRow[] {
  return text.split("\n").flatMap((line) => {
    if (!line.startsWith("|")) return [];
    const [id, brief, kind, owner, status, evidence] = line
      .slice(1)
      .split("|")
      .map((s) => s.trim());
    if (!id || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id) || !brief || !kind || !owner || !status)
      return [];
    return [{ id, brief, kind, owner, status, evidence: evidence ?? "" }];
  });
}

const ClaimSchema = z.object({
  project: z.string(),
  item: z.string(),
  role: z.string(),
  sessionId: z.string().nullable(),
  operationId: z.string(),
  stage: z.enum(["creating", "created", "started", "uncertain"]),
});
const EndSchema = z.object({
  project: z.string(),
  item: z.string(),
  eventId: z.string(),
  result: ResultSchema.nullable(),
});
const StateSchema = z.object({
  version: z.literal(1),
  claims: z.array(ClaimSchema),
  ends: z.record(z.string(), EndSchema),
});
type RoutingState = z.infer<typeof StateSchema>;

interface RoutingDeps {
  statePath: string;
  ledgerDir: string;
  config: () => Record<string, ProjectDispatch>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  ensureWorkspace: (cwd: string) => Promise<string>;
  logger: Logger;
}

export class LedgerRoutingService {
  private state: RoutingState;
  private lane: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private stopped = false;

  constructor(private readonly deps: RoutingDeps) {
    try {
      this.state = StateSchema.parse(JSON.parse(readFileSync(deps.statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { version: 1, claims: [], ends: {} };
    }
  }

  stop(): void {
    this.stopped = true;
    this.revision++;
  }

  enabledForLead(id: string): boolean {
    return Object.values(this.deps.config()).some(
      (config) => config.enabled && config.leadId === id,
    );
  }

  private save(): void {
    writePrivateFileAtomicSync(this.deps.statePath, JSON.stringify(this.state), { durable: true });
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lane.then(run);
    this.lane = result.catch((err: unknown) =>
      this.deps.logger.warn({ err }, "Ledger routing failed"),
    );
    return result;
  }

  private binding(
    worker: LineAgent,
  ): { project: string; item: string; config: ProjectDispatch } | null {
    const project = worker.labels?.["fulcra.project"];
    const item = worker.labels?.["fulcra.item"];
    if (!project || !item || worker.archivedAt) return null;
    const config = this.deps.config()[project];
    const role = worker.labels?.["fulcra.role"];
    if (
      !config?.enabled ||
      reportsTo(worker) !== config.leadId ||
      !config.roles.some((r) => r.role === role)
    )
      return null;
    return { project, item, config };
  }

  /** Called once at the real turn boundary. Notice turns never produce another result. */
  observeEnd(input: {
    worker: LineAgent;
    eventId: string;
    text: string | null;
    failed: boolean;
    fromNotice: boolean;
  }): Promise<{ result: WorkerResult | null; fresh: boolean } | null> {
    return this.enqueue(async () => {
      if (this.stopped || input.fromNotice) return null;
      const binding = this.binding(input.worker);
      if (!binding) return null;
      const prior = this.state.ends[input.worker.id];
      if (prior?.eventId === input.eventId) return { result: prior.result, fresh: false };
      const result = input.failed ? null : parseWorkerResult(input.text);
      this.state.ends[input.worker.id] = {
        project: binding.project,
        item: binding.item,
        eventId: input.eventId,
        result,
      };
      this.save();
      // Report delivery has its own durable finish lane and cannot delay work selection.
      await this.dispatch();
      return { result, fresh: true };
    });
  }

  begin(worker: LineAgent): void {
    const binding = this.binding(worker);
    if (!binding || this.stopped) return;
    if (this.state.ends[worker.id]) this.revision++;
    this.state.ends[worker.id] = {
      project: binding.project,
      item: binding.item,
      eventId: randomUUID(),
      result: null,
    };
    this.save();
  }

  wake(): Promise<void> {
    return this.enqueue(() => this.dispatch());
  }

  changed(): Promise<void> {
    this.revision++;
    return this.enqueue(() => this.dispatch());
  }

  private async rows(project: string): Promise<DispatchRow[]> {
    const file = path.join(this.deps.ledgerDir, project, "OPEN-ITEMS.md");
    if ((await stat(file)).size > 512 * 1024) throw new Error("Ledger exceeds its size limit");
    return parseDispatchRows(await readFile(file, "utf8"));
  }

  private released(sessionId: string, rows: readonly DispatchRow[]): boolean {
    const end = this.state.ends[sessionId];
    if (end?.result?.state !== "DONE") return false;
    return rows.some(
      (row) =>
        row.id === end.item &&
        row.status === "DONE" &&
        row.evidence.trim().length > 0 &&
        !/^(?:—|-|none|n\/a)$/i.test(row.evidence.trim()),
    );
  }

  private held(agent: LineAgent, config: ProjectDispatch): boolean {
    const labels = agent.labels ?? {};
    return Boolean(
      labels["fulcra.hold"]?.trim() ||
      labels["fulcra.dispatch"] === "off" ||
      config.holdLabels.some((label) => Boolean(labels[label]?.trim())),
    );
  }

  private projectAgents(project: string, agents: readonly LineAgent[]): LineAgent[] {
    return agents.filter(
      (agent) =>
        agent.labels?.["fulcra.project"] === project &&
        agent.id !== this.deps.config()[project]?.leadId,
    );
  }

  private occupied(
    project: string,
    agents: readonly LineAgent[],
    rows: readonly DispatchRow[],
    config: ProjectDispatch,
  ): number {
    const claims = this.state.claims.filter((claim) => claim.project === project);
    const claimedIds = new Set(
      claims.flatMap((claim) => (claim.sessionId ? [claim.sessionId] : [])),
    );
    const claimsBusy = claims.filter((claim) => {
      if (!claim.sessionId) return true;
      const agent = agents.find((a) => a.id === claim.sessionId);
      return (
        !this.released(claim.sessionId, rows) ||
        Boolean(agent && this.held(agent, config)) ||
        this.deps.agentManager.hasInFlightRun(claim.sessionId)
      );
    }).length;
    const externalBusy = this.projectAgents(project, agents).filter((agent) => {
      if (claimedIds.has(agent.id)) return false;
      if (agent.labels?.["fulcra.item"])
        return (
          !this.released(agent.id, rows) ||
          this.held(agent, config) ||
          this.deps.agentManager.hasInFlightRun(agent.id)
        );
      const live = this.deps.agentManager.getAgent(agent.id);
      return (
        this.held(agent, config) ||
        live?.lifecycle === "running" ||
        this.deps.agentManager.hasInFlightRun(agent.id)
      );
    }).length;
    return claimsBusy + externalBusy;
  }

  private async dispatch(): Promise<void> {
    if (this.stopped) return;
    for (const [project, config] of Object.entries(this.deps.config())) {
      if (!config.enabled) continue;
      try {
        await this.dispatchProject(project, config);
      } catch (err) {
        this.deps.logger.warn({ err, project }, "Ledger routing project unavailable");
      }
    }
  }

  private async dispatchProject(project: string, config: ProjectDispatch): Promise<void> {
    const rows = await this.rows(project);
    const agents = await this.deps.agentStorage.list();
    const lead = agents.find((agent) => agent.id === config.leadId);
    if (!lead || lead.archivedAt || this.held(lead, config)) return;
    const claimedItems = new Set(
      this.state.claims.filter((c) => c.project === project).map((c) => c.item),
    );
    for (const agent of this.projectAgents(project, agents)) {
      const item = agent.labels?.["fulcra.item"];
      if (item) claimedItems.add(item);
    }
    let slots = config.maxParallel - this.occupied(project, agents, rows, config);
    for (const row of rows) {
      if (slots <= 0 || this.stopped) break;
      if (
        !/^(OPEN|IN PROGRESS|READY)\b/.test(row.status) ||
        !isLedgerRowReady(row) ||
        !["BUILD", "FIX"].includes(row.kind) ||
        claimedItems.has(row.id)
      )
        continue;
      const role = config.roles.find((r) => r.owner === row.owner);
      if (!role) continue;
      // A blocked role retains its slot, even when another role has capacity.
      const roleHeld = agents.some(
        (agent) =>
          agent.labels?.["fulcra.project"] === project &&
          agent.labels?.["fulcra.role"] === role.role &&
          (this.held(agent, config) ||
            ["BLOCKED", "DECISION"].includes(this.state.ends[agent.id]?.result?.state ?? "")),
      );
      if (roleHeld) continue;
      await this.start(project, config, role, row, rows);
      claimedItems.add(row.id);
      slots--;
    }
  }

  private async start(
    project: string,
    config: ProjectDispatch,
    role: ProjectDispatch["roles"][number],
    row: DispatchRow,
    rows: readonly DispatchRow[],
  ): Promise<void> {
    const revision = this.revision;
    const template = JSON.stringify(config);
    const claim: z.infer<typeof ClaimSchema> = {
      project,
      item: row.id,
      role: role.role,
      sessionId: null,
      operationId: randomUUID(),
      stage: "creating",
    };
    const check = (prepared?: AgentSessionConfig) => {
      const current = this.deps.config()[project];
      const lead = this.deps.agentStorage.getCached(config.leadId);
      if (
        this.stopped ||
        revision !== this.revision ||
        JSON.stringify(current) !== template ||
        !lead ||
        lead.archivedAt ||
        this.held(lead, config)
      )
        throw new Error("Ledger dispatch admission changed");
      if (prepared) assertPreparedTemplate(prepared, role);
      const currentAgents = this.deps.agentStorage.listCached();
      if (this.occupied(project, currentAgents, rows, config) > config.maxParallel)
        throw new Error("Ledger dispatch concurrency limit reached");
      const worker = currentAgents.find((agent) => agent.id === claim.sessionId);
      if (worker && (worker.archivedAt || this.held(worker, config)))
        throw new Error("Ledger dispatch worker held or archived");
      for (const agent of currentAgents) {
        if (agent.id === claim.sessionId || agent.labels?.["fulcra.project"] !== project) continue;
        if (agent.labels?.["fulcra.item"] === row.id)
          throw new Error("Ledger item already has a session");
      }
    };
    this.state.claims.push(claim);
    this.save(); // An uncertain creation consumes the item and slot across restart.
    try {
      check();
      const workspaceId = await this.deps.ensureWorkspace(role.cwd);
      check();
      const created = await this.deps.agentManager.trustedPlugins.daemon(() =>
        this.deps.createAgent({
          kind: "mcp",
          provider: formatProviderModel(role.provider, role.model),
          title: row.id,
          cwd: role.cwd,
          workspaceId,
          mode: role.mode,
          thinking: role.thinking,
          callerAgentId: config.leadId,
          background: true,
          notifyOnFinish: false,
          creationAdmission: check,
          labels: {
            "fulcra.project": project,
            "fulcra.role": role.role,
            "fulcra.item": row.id,
            "fulcra.reports-to": config.leadId,
            "fulcra.dispatch-id": claim.operationId,
          },
          onCreated: ({ agentId }) => {
            claim.sessionId = agentId;
            claim.stage = "created";
            this.save();
          },
        }),
      );
      check();
      await this.deps.agentStorage.armFinishNotice(created.snapshot, config.leadId, "report-up");
      const finalCheck = createFinalInputCheck(check);
      await this.deps.agentManager.trustedPlugins.daemon(() =>
        sendPromptToAgent({
          agentManager: this.deps.agentManager,
          agentStorage: this.deps.agentStorage,
          agentId: created.snapshot.id,
          prompt: row.brief,
          messageId: `ledger-dispatch:${claim.operationId}`,
          unarchive: false,
          runOptions: { [FINAL_INPUT_CHECK]: finalCheck },
          logger: this.deps.logger,
        }),
      );
      claim.stage = "started";
      this.save();
    } catch (err) {
      claim.stage = "uncertain";
      this.save();
      this.deps.logger.warn(
        { err, project, item: row.id, sessionId: claim.sessionId },
        "Ledger dispatch retained for reconciliation",
      );
    }
  }
}

function assertPreparedTemplate(
  prepared: AgentSessionConfig,
  role: ProjectDispatch["roles"][number],
): void {
  if (
    prepared.provider !== role.provider ||
    prepared.model !== role.model ||
    prepared.modeId !== role.mode ||
    prepared.cwd !== role.cwd ||
    prepared.thinkingOptionId !== role.thinking
  )
    throw new Error("Ledger dispatch template changed during preparation");
}

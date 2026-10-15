import { startHostLimitSharing } from "./host-limit-sharing.js";
import { realpathSync } from "node:fs";
import type { Logger } from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { createFinalInputCheck, waitForFinalInputHandoff } from "./agent/final-input-check.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  SteerUnavailableError,
} from "./agent/agent-prompt.js";
import { heldSendsFor } from "./held-sends.js";
import { findRoleHolder, reportsTo, type LineAgent } from "./reporting-lines.js";
import {
  HostLinks,
  HostLinkError,
  type HostLinkDelivery,
  type HostLinkRoleNotice,
  type HostLinkFinishDelivery,
} from "./host-links.js";

export interface HostLinkRuntimeInput {
  home: string;
  serverId: string;
  protected: () => boolean;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  workspace: (cwd: string) => Promise<string>;
}
export async function createHostLinkRuntime(input: HostLinkRuntimeInput) {
  const { agentManager, agentStorage, logger } = input;
  // Seed before the listener starts. Later label writes publish state synchronously before provider admission.
  const directory = new Map<string, LineAgent>();
  const remember = (agent: LineAgent) =>
    directory.set(agent.id, {
      id: agent.id,
      labels: agent.labels,
      archivedAt: agent.archivedAt,
    });
  for (const record of await agentStorage.list()) if (!record.internal) remember(record);
  for (const agent of agentManager.listAgents()) remember(agent);
  function lastWorkerMessage(agentId: string): string {
    const messages = agentManager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    return messages.at(-1)?.text?.slice(0, 3000) ?? "";
  }
  let service: HostLinks | null = null;
  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state" && !event.agent.internal) remember(event.agent);
      if (event.type === "agent_state" && event.agent.lifecycle === "error" && service) {
        try {
          service.recordWorkerNotice(
            event.agent.id,
            "failed",
            "state-error",
            event.agent.lastError ?? "The remote worker failed.",
          );
        } catch (error) {
          logger.error(
            { err: error, agentId: event.agent.id },
            "Could not retain a host-link worker error",
          );
        }
      }
      if (event.type !== "agent_stream" || !service) return;
      try {
        if (event.event.type === "turn_started") service.recordWorkerStarted(event.agentId);
        else if (event.event.type === "turn_completed")
          service.recordWorkerNotice(
            event.agentId,
            "finished",
            event.event.turnId ?? "initial",
            `The remote worker finished its turn.\n${lastWorkerMessage(event.agentId)}`,
          );
        else if (event.event.type === "turn_failed")
          service.recordWorkerNotice(
            event.agentId,
            "failed",
            event.event.turnId ?? "initial",
            event.event.error,
          );
        else if (event.event.type === "turn_canceled")
          service.recordWorkerNotice(
            event.agentId,
            "failed",
            event.event.turnId ?? "initial",
            `The remote turn stopped: ${event.event.reason}`,
          );
        else if (event.event.type === "permission_resolved")
          service.resolveWorkerPermission(event.agentId, event.event.requestId);
        else if (event.event.type === "permission_requested")
          service.recordWorkerNotice(
            event.agentId,
            "permission",
            event.event.request.id,
            `Permission request ${event.event.request.id}:\n${JSON.stringify(event.event.request)}`,
          );
      } catch (error) {
        logger.error(
          { err: error, agentId: event.agentId },
          "Could not retain a host-link worker notice",
        );
      }
    },
    { replayState: false },
  );
  const deliver = async (delivery: HostLinkDelivery, notice: boolean) => {
    const run = async () => {
      const final = createFinalInputCheck(delivery.check);
      delivery.check();
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: delivery.agentId,
        prompt: notice ? formatSystemNotificationPrompt(delivery.text) : delivery.text,
        messageId: notice
          ? `${FINISH_NOTIFICATION_MESSAGE_PREFIX}host-link:${delivery.messageId}`
          : delivery.messageId,
        runOptions: { [FINAL_INPUT_CHECK]: final },
        activeTurnBehavior: "steer",
        steerOnly: true,
        unarchive: false,
        logger,
      });
      await waitForFinalInputHandoff(final);
    };
    if (notice) await agentManager.trustedPlugins.daemon(run);
    else await agentManager.trustedPlugins.agentInput(run);
  };
  const roleNotice = (request: HostLinkRoleNotice): Promise<string> => {
    let complete!: (id: string) => void;
    let fail!: (error: unknown) => void;
    const completion = new Promise<string>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    let redirects = 0;
    const enqueue = (agentId: string) => {
      try {
        heldSendsFor(agentManager, logger).hold(agentId, () => attempt(agentId));
      } catch (error) {
        fail(error);
      }
    };
    const attempt = async (agentId: string) => {
      try {
        request.check();
        const current = request.currentTarget();
        if (!current) throw new HostLinkError("refused", "The main assistant has no chat.");
        if (current !== agentId) {
          if (++redirects > 8)
            throw new HostLinkError("refused", "The main assistant keeps changing.");
          enqueue(current);
          return;
        }
        await deliver({ ...request, agentId, check: () => request.checkTarget(agentId) }, true);
        complete(agentId);
      } catch (error) {
        if (error instanceof SteerUnavailableError) throw error;
        fail(error);
      }
    };
    enqueue(request.agentId);
    return completion;
  };
  const finish = (request: HostLinkFinishDelivery): Promise<void | "suppressed"> =>
    agentManager.withAgentCaller(undefined, () =>
      agentManager.trustedPlugins.daemon(() => finishToLead(request)),
    );
  async function finishToLead(request: HostLinkFinishDelivery): Promise<void | "suppressed"> {
    request.check();
    const stored = await agentStorage.get(request.agentId);
    if (
      !stored ||
      stored.archivedAt ||
      (stored.persistence?.sessionId ?? null) !== request.sourceSessionId
    )
      throw new HostLinkError("refused", "The calling lead is archived or its session changed.");
    const receiver = await ensureAgentLoaded(request.agentId, {
      agentManager,
      agentStorage,
      logger,
    });
    const instanceId = receiver.instanceId;
    const check = () => {
      request.check();
      const current = agentManager.getAgent(request.agentId);
      if (
        !current ||
        current.archivedAt ||
        current.instanceId !== instanceId ||
        (current.persistence?.sessionId ?? null) !== request.sourceSessionId
      )
        throw new HostLinkError("refused", "The calling lead changed before notice delivery.");
    };
    let suppressed = false;
    await heldSendsFor(agentManager, logger).holdAndWait(request.agentId, () =>
      agentManager.withAgentCaller(undefined, () =>
        agentManager.trustedPlugins.daemon(async () => {
          if (request.prepare && !(await request.prepare())) {
            suppressed = true;
            return;
          }
          const final = createFinalInputCheck(check, request.beforeHandoff);
          check();
          await sendPromptToAgent({
            agentManager,
            agentStorage,
            agentId: request.agentId,
            prompt: formatSystemNotificationPrompt(request.text),
            messageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}host-link-return:${request.messageId}`,
            runOptions: { [FINAL_INPUT_CHECK]: final },
            activeTurnBehavior: "steer",
            steerOnly: true,
            unarchive: false,
            logger,
          });
          await waitForFinalInputHandoff(final);
        }),
      ),
    );
    if (suppressed) return "suppressed";
  }

  const workerCurrent = (
    id: string,
    profile: { provider: string; modeId: string; model: string },
    parent: string,
  ) => {
    const agent = agentManager.getAgent(id);
    if (
      !agent ||
      agent.archivedAt ||
      agent.provider !== profile.provider ||
      agent.config.model !== profile.model ||
      agent.currentModeId !== profile.modeId ||
      reportsTo(agent) !== parent
    )
      throw new HostLinkError("refused", "The worker changed before input admission.");
  };
  service = new HostLinks({
    home: input.home,
    serverId: input.serverId,
    protected: input.protected,
    finish,
    permissionPending: (agentId, requestId) => {
      const worker = agentManager.getAgent(agentId);
      return Boolean(
        worker &&
        !worker.archivedAt &&
        !worker.internal &&
        worker.pendingPermissions.has(requestId),
      );
    },
    noticeError: (error) => logger.warn({ err: error }, "Host-link finish notice remains retained"),
    chat: async (id) => {
      const live = agentManager.getAgent(id);
      const saved = live ? null : await agentStorage.get(id);
      const record = live ?? saved;
      if (!record || record.internal) return null;
      const provider = record.provider;
      const modeId = live ? live.currentModeId : (saved?.lastModeId ?? null);
      const isLead = [...directory.values()].some(
        (child) =>
          !child.archivedAt &&
          (reportsTo(child) === id || reportsTo(child) === `${id}@${input.serverId}`),
      );
      return {
        id,
        provider,
        modeId,
        model: record.config?.model ?? null,
        sessionId: record.persistence?.sessionId ?? null,
        reportsTo: reportsTo(record),
        archived: Boolean(record.archivedAt),
        isLead,
      };
    },
    mainAssistant: () => {
      const holder = findRoleHolder([...directory.values()], "main-assistant");
      if (holder && "ambiguous" in holder)
        throw new HostLinkError("refused", "The main assistant has two holders.");
      return holder?.id ?? null;
    },
    workerCurrent,
    create: async (request) =>
      agentManager.trustedPlugins.agentInput(async () => {
        request.check();
        const workspaceId = await input.workspace(request.cwd);
        request.check();
        const config = {
          provider: request.profile.provider,
          model: request.profile.model,
          modeId: request.profile.modeId,
          cwd: request.cwd,
          title: request.title,
        };
        await agentManager.createAgent(config, request.agentId, {
          workspaceId,
          labels: { "fulcra.reports-to": request.parent, "fulcra.host-link-worker": "true" },
          creationAdmission: (prepared) => {
            request.check();
            if (
              prepared.provider !== config.provider ||
              prepared.modeId !== config.modeId ||
              prepared.model !== config.model ||
              prepared.cwd !== config.cwd ||
              realpathSync(config.cwd) !== config.cwd
            )
              throw new HostLinkError(
                "refused",
                "The prepared worker exceeds its host-link grant.",
              );
          },
        });
        workerCurrent(request.agentId, request.profile, request.parent);
        const final = createFinalInputCheck(() => {
          request.check();
          workerCurrent(request.agentId, request.profile, request.parent);
        });
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId: request.agentId,
          prompt: request.prompt,
          messageId: request.messageId,
          runOptions: { [FINAL_INPUT_CHECK]: final },
          activeTurnBehavior: "steer",
          steerOnly: true,
          unarchive: false,
          logger,
        });
        await waitForFinalInputHandoff(final);
      }),
    notice: roleNotice,
    prompt: (request) =>
      heldSendsFor(agentManager, logger).holdAndWait(request.agentId, () =>
        deliver(request, false),
      ),
    inspect: async (id) => {
      const agent = agentManager.getAgent(id);
      const stored = agent ? null : await agentStorage.get(id);
      return {
        agentId: id,
        status: agent?.lifecycle ?? stored?.lastStatus ?? "closed",
        lastMessage: await agentManager.getLastAssistantMessage(id),
      };
    },
  });
  const stopSharing = startHostLimitSharing(service, input.home, () =>
    logger.warn("Account limit sharing failed; the next pass will retry."),
  );
  let closed = false;
  const recover = () => {
    if (closed) return;
    try {
      for (const pending of service!.pendingNoticeWorkers()) {
        const record = agentStorage
          .listCached()
          .find((candidate) => candidate.id === pending.agentId);
        if (!record || !pending.started || agentManager.hasInFlightRun(pending.agentId)) continue;
        if (
          record.interruptedTurn ||
          record.lastStatus === "error" ||
          record.lastStatus === "closed" ||
          record.attentionReason === "permission"
        )
          service!.recordWorkerNotice(
            pending.agentId,
            "failed",
            "recovered",
            "The remote turn stopped before daemon recovery.",
          );
        else if (record.lastStatus === "idle")
          service!.recordWorkerNotice(
            pending.agentId,
            "finished",
            "recovered",
            "The remote worker's completed turn was recovered.",
          );
      }
      service!.startNotifications();
    } catch (error) {
      service!.stopNotifications();
      logger.error({ err: error }, "Host-link receipt recovery requires owner repair");
    }
  };
  const close = () => {
    closed = true;
    stopSharing();
    unsubscribe();
    service!.stopNotifications();
  };
  return { service, start: recover, close };
}

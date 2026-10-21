import { sessionCost } from "./agent/session-cost.js";
import { loadAgentPolicy } from "./limit-resume/policy.js";
import { noticePaused, NoticePausedError } from "./notice-pause.js";
import { queuedAgentMessagesFor } from "./queued-agent-messages.js";
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
  registerHostLinks,
  HostLinkError,
  HostLinkStorageError,
  type HostLinkDelivery,
  type HostLinkRoleNotice,
  type HostLinkFinishDelivery,
} from "./host-links.js";

import {
  WindowsPrivateFileReconciliationError,
  waitForWindowsPrivateFilesSettled,
} from "./windows-private-file.js";

export interface HostLinkRuntimeInput {
  home: string;
  serverId: string;
  protected: () => boolean;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  workspace: (cwd: string) => Promise<string>;
}
/**
 * FU-462: the boot directory holds live sessions only. An archived session that boot left on disk is read from
 * storage, so a host-link acknowledgement still sees that the worker is archived.
 */
export function workerArchivedAt(
  entry: { archivedAt?: string | Date | null } | undefined,
  readStored: () => { archivedAt?: string | Date | null } | null,
): boolean {
  return Boolean(entry?.archivedAt ?? readStored()?.archivedAt);
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
  for (const record of await agentStorage.listLoaded()) if (!record.internal) remember(record);
  for (const agent of agentManager.listAgents()) remember(agent);
  function lastWorkerMessage(agentId: string): string {
    const messages = agentManager
      .getTimeline(agentId)
      .filter((item) => item.type === "assistant_message");
    return messages.at(-1)?.text?.slice(0, 3000) ?? "";
  }
  const { formatWorkerFinish } = loadAgentPolicy("report-notices");
  function finishText(id: string, text: string): string {
    return formatWorkerFinish(
      text,
      sessionCost((agentManager.getAgent(id) ?? agentStorage.getCached(id))?.costRecords),
    );
  }
  let service: HostLinks | null = null;
  let closed = false;
  let reconciliation: Promise<void> | undefined;
  const waiting = new Set<string>();
  const noticeFailure = (agentId: string, error: unknown, eventType?: string) => {
    if (eventType === "turn_started" || eventType === "permission_resolved") return;
    service?.recordWorkerNoticeFailure(agentId, error);
  };
  const settled = () => {
    if (!reconciliation) {
      const run = waitForWindowsPrivateFilesSettled();
      reconciliation = run;
      void run
        .finally(() => {
          if (reconciliation === run) reconciliation = undefined;
        })
        .catch(() => {});
    }
    return reconciliation;
  };
  // Retry only journal persistence. Provider input never passes through this queue.
  const persist = (
    agentId: string,
    eventType: string,
    key: string,
    operation: () => void,
  ): void => {
    if (closed) return;
    try {
      operation();
    } catch (error) {
      if (error instanceof WindowsPrivateFileReconciliationError) {
        if (waiting.has(key)) return;
        waiting.add(key);
        void settled()
          .then(() => {
            waiting.delete(key);
            if (closed) return;
            if (!error.receipt) return persist(agentId, eventType, key, operation);
            const outcome = Atomics.load(error.receipt, 0);
            if (outcome === 1) {
              if (["finished", "failed"].includes(eventType))
                service?.clearWorkerNoticeFailure(agentId);
              return;
            }
            if (outcome !== -1)
              throw new Error("Windows receipt still needs reconciliation.", { cause: error });
            const failure = new HostLinkStorageError("write");
            noticeFailure(agentId, failure, eventType);
            logger.error({ err: failure, agentId }, "Could not retain a host-link worker notice");
            return undefined;
          })
          .catch((failure) => {
            waiting.delete(key);
            if (!closed)
              logger.error(
                { err: failure, agentId },
                "Host-link receipt reconciliation needs owner repair",
              );
          });
        return;
      }
      noticeFailure(agentId, error, eventType);
      logger.error({ err: error, agentId }, "Could not retain a host-link worker notice");
    }
  };
  const recordNotice = (...args: Parameters<HostLinks["recordWorkerNotice"]>) =>
    persist(args[0], args[1], `${args[0]}:${args[1]}:${args[2]}`, () => {
      if (service?.recordWorkerNotice(...args) === "retired")
        logger.warn(
          { agentId: args[0] },
          "A retired host-link worker emitted a notice. Reconcile it before more work.",
        );
    });
  const unsubscribe = agentManager.subscribe(
    (event) => {
      try {
        if (event.type === "agent_state" && !event.agent.internal) remember(event.agent);
        if (event.type === "agent_state" && event.agent.lifecycle === "error" && service)
          recordNotice(
            event.agent.id,
            "failed",
            "state-error",
            finishText(event.agent.id, event.agent.lastError ?? "The remote worker failed."),
          );
        if (event.type !== "agent_stream" || !service) return;
        const id = event.agentId;
        const stream = event.event;
        if (stream.type === "turn_started")
          persist(id, stream.type, `${id}:start:${stream.turnId}`, () =>
            service?.recordWorkerStarted(id, stream.turnId),
          );
        else if (stream.type === "turn_completed")
          recordNotice(
            id,
            "finished",
            stream.turnId ?? "initial",
            finishText(id, `The remote worker finished its turn.\n${lastWorkerMessage(id)}`),
            stream.turnId,
          );
        else if (stream.type === "turn_failed")
          recordNotice(
            id,
            "failed",
            stream.turnId ?? "initial",
            finishText(id, stream.error),
            stream.turnId,
          );
        else if (stream.type === "turn_canceled")
          recordNotice(
            id,
            "failed",
            stream.turnId ?? "initial",
            finishText(id, `The remote turn stopped: ${stream.reason}`),
            stream.turnId,
          );
        else if (stream.type === "permission_resolved")
          persist(id, stream.type, `${id}:permission:${stream.requestId}`, () =>
            service?.resolveWorkerPermission(id, stream.requestId),
          );
        else if (stream.type === "permission_requested")
          recordNotice(
            id,
            "permission",
            stream.request.id,
            `Permission request ${stream.request.id}:\n${JSON.stringify(stream.request)}`,
          );
      } catch (error) {
        logger.error({ err: error }, "Could not prepare a host-link worker notice");
      }
    },
    { replayState: false },
  );
  const deliver = async (delivery: HostLinkDelivery, notice: boolean) => {
    const run = async () => {
      const check = () => {
        delivery.check();
        if (
          !notice &&
          noticePaused(
            agentStorage.noticePausePath,
            agentManager.getAgent(delivery.agentId),
            (id) => agentManager.getAgent(id) ?? agentStorage.getCached(id),
          )
        )
          throw new NoticePausedError();
      };
      const final = createFinalInputCheck(check, delivery.beforeSend);
      check();
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
    if (agent?.labels["fulcra.hold"] === "done")
      throw new HostLinkError("refused", "The worker is held as done.");
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
    workerArchived: (id) => workerArchivedAt(directory.get(id), () => agentStorage.getCached(id)),
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
    prompt: async (request) => {
      if (request.steer) {
        try {
          await deliver(request, false);
          return;
        } catch (error) {
          if (!(error instanceof SteerUnavailableError) && !(error instanceof NoticePausedError))
            throw error;
        }
      }
      if (!request.parent)
        throw new HostLinkError("refused", "Remote prompt has no parent identity.");
      await queuedAgentMessagesFor({ agentManager, agentStorage, logger }).enqueue(
        request.agentId,
        {
          text: request.text,
          messageId: request.messageId,
          sender: request.parent,
          hostLinkMessageId: request.messageId,
        },
        input.serverId,
      );
    },
    promptState: (agentId, messageId) =>
      queuedAgentMessagesFor({ agentManager, agentStorage, logger }).messageState(
        agentId,
        messageId,
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
  registerHostLinks(agentManager, service);
  const stopSharing = startHostLimitSharing(service, input.home, () =>
    logger.warn("Account limit sharing failed; the next pass will retry."),
  );
  const recover = async () => {
    if (closed) return;
    try {
      await service!.recoverPromptAdmissions();
      if (closed) return;
      for (const pending of service!.pendingNoticeWorkers()) {
        const record = agentStorage.getCached(pending.agentId);
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
            finishText(pending.agentId, "The remote turn stopped before daemon recovery."),
          );
        else if (record.lastStatus === "idle")
          service!.recordWorkerNotice(
            pending.agentId,
            "finished",
            "recovered",
            finishText(pending.agentId, "The remote worker's completed turn was recovered."),
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

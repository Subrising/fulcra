import { loadAgentPolicy } from "./policy.js";
import type { PolicyHooks } from "../../../../../plugins/fulcra-agent-policy/index.host.mjs";
import type { Logger } from "pino";
import { FINAL_INPUT_CHECK } from "../agent/agent-sdk-types.js";
import {
  createFinalInputCheck,
  FINAL_INPUT_HANDOFF_MS,
  waitForFinalInputHandoff,
} from "../agent/final-input-check.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { LIMIT_RESUME_OPT_OUT_LABEL, LimitResumeService } from "./service.js";

/** The handoff wait for a resume that must first wake a sleeping session. */
const SLEEPING_RESUME_HANDOFF_MS = 120_000;

/** Starts auto-resume for this host: listens to agent events, keeps the durable queue, resumes at reset. */
export function startLimitResume(input: {
  paseoHome: string;
  now?: () => number;
  hooks?: PolicyHooks;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  logger: Logger;
}): LimitResumeService {
  const { agentManager, agentStorage, logger } = input;
  const service = new LimitResumeService({
    paseoHome: input.paseoHome,
    now: input.now,
    isEnabled: () => input.daemonConfigStore.get().autoResumeOnLimit !== false,
    captureBinding: (agentId) => agentManager.getLimitResumeBinding(agentId),
    getAgent: async (agentId, forResume) => {
      // Failed starts publish turn_failed while their pending run is still tracked. Observe
      // the settled state, otherwise a genuine limit stop is mistaken for a busy session.
      await agentManager.waitForFailedRunSettlement(agentId);
      let live = agentManager.getAgent(agentId);
      if (!live && forResume)
        live = await ensureUnarchivedAgentLoaded(agentId, { agentManager, agentStorage, logger });
      if (live) {
        return {
          labels: live.labels,
          archived: false,
          busy: agentManager.hasInFlightRun(agentId),
          unscopedResumeAllowed: agentManager.canRunUnscopedLimitResume(agentId),
          binding: agentManager.getLimitResumeBinding(agentId),
        };
      }
      const record = await agentStorage.get(agentId);
      if (!record) return null;
      return {
        labels: record.labels ?? {},
        archived: Boolean(record.archivedAt),
        busy: false,
        unscopedResumeAllowed: false,
        binding: null,
        stored: true,
      };
    },
    getLastAssistantMessage: (agentId) => agentManager.getLastAssistantMessage(agentId),
    // An empty value clears the marker; labels cannot be deleted through the metadata path.
    setMarker: async (agentId, resumeAtIso, reason) => {
      await agentManager.updateLimitResumeMarker(agentId, resumeAtIso, reason);
    },
    sendResume: async (agentId, prompt, stillWanted, consume, originalBinding) => {
      await ensureUnarchivedAgentLoaded(agentId, { agentManager, agentStorage, logger });
      const live = agentManager.getAgent(agentId);
      if (!live || agentManager.hasInFlightRun(agentId)) return;
      const checkCurrent = () => {
        const current = agentManager.getAgent(agentId);
        if (
          !stillWanted() ||
          !current ||
          current.session !== live.session ||
          current.instanceId !== live.instanceId ||
          current.archivedAt ||
          current.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off" ||
          !agentManager.canRunUnscopedLimitResume(agentId) ||
          agentManager.getLimitResumeBinding(agentId) !== originalBinding
        )
          throw new Error("Unscoped limit resume refused");
      };
      checkCurrent();
      // A session that slept through the reset starts its provider process first. A wake of 30.5 s was seen,
      // past the default handoff wait; the queue entry was cancelled and the late wake was refused.
      const handoffMs = agentManager.isAgentSleeping(agentId)
        ? SLEEPING_RESUME_HANDOFF_MS
        : FINAL_INPUT_HANDOFF_MS;
      const finalCheck = createFinalInputCheck(checkCurrent, consume);
      // Refusal checks repeat after provider preparation; only the concrete native send consumes.
      void agentManager
        .runAgent(agentId, prompt, { [FINAL_INPUT_CHECK]: finalCheck })
        .catch((error: unknown) => {
          logger.warn({ err: error, agentId }, "Auto-resume turn failed");
        });
      await waitForFinalInputHandoff(finalCheck, handoffMs);
    },
    onError: (error) => logger.warn({ err: error }, "Auto-resume step failed"),
    onSkip: (agentId, reason) =>
      logger.info(
        { agentId, reason },
        reason === "archived" ? "Auto-resume dropped: session archived" : "Auto-resume skipped",
      ),
  });
  service.start();
  const offHooks = input.hooks
    ? loadAgentPolicy("hooks").registerRecoveryHooks(input.hooks, service)
    : undefined;
  const instances = new Map(agentManager.listAgents().map((agent) => [agent.id, agent.instanceId]));
  const offStream = agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state") {
        const agent = event.agent;
        const changed = instances.has(agent.id) && instances.get(agent.id) !== agent.instanceId;
        instances.set(agent.id, agent.instanceId);
        if (changed || agent.lifecycle === "closed")
          void service
            .onAgentEvent({ type: "agent_reloaded", agentId: agent.id })
            .catch((error) => logger.warn({ err: error }, "Auto-resume reload recovery failed"));
        return;
      }
      // Native hooks own turn endings. Timeline-only binding snapshots retain restart protection.
      if (input.hooks && (event.type !== "agent_stream" || event.event.type !== "timeline")) return;
      void service
        .onAgentEvent(event)
        .catch((error) => logger.warn({ err: error }, "Auto-resume event failed"));
    },
    { replayState: false },
  );
  service.onStop(() => {
    offHooks?.();
    offStream();
  });
  return service;
}

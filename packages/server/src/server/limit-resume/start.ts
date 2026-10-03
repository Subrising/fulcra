import type { Logger } from "pino";
import { FINAL_INPUT_CHECK } from "../agent/agent-sdk-types.js";
import { createFinalInputCheck, waitForFinalInputHandoff } from "../agent/final-input-check.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { LIMIT_RESUME_OPT_OUT_LABEL, LimitResumeService } from "./service.js";

/** Starts auto-resume for this host: listens to agent events, keeps the durable queue, resumes at reset. */
export function startLimitResume(input: {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  logger: Logger;
}): LimitResumeService {
  const { agentManager, agentStorage, logger } = input;
  const service = new LimitResumeService({
    paseoHome: input.paseoHome,
    isEnabled: () => input.daemonConfigStore.get().autoResumeOnLimit !== false,
    getAgent: async (agentId) => {
      // Failed starts publish turn_failed while their pending run is still tracked. Observe
      // the settled state, otherwise a genuine limit stop is mistaken for a busy session.
      await agentManager.waitForFailedRunSettlement(agentId);
      const live = agentManager.getAgent(agentId);
      if (live) {
        return {
          labels: live.labels,
          archived: false,
          busy: agentManager.hasInFlightRun(agentId),
          unscopedResumeAllowed: agentManager.canRunUnscopedLimitResume(agentId),
        };
      }
      const record = await agentStorage.get(agentId);
      if (!record) return null;
      return {
        labels: record.labels ?? {},
        archived: Boolean(record.archivedAt),
        busy: false,
        unscopedResumeAllowed: false,
      };
    },
    getLastAssistantMessage: (agentId) => agentManager.getLastAssistantMessage(agentId),
    // An empty value clears the marker; labels cannot be deleted through the metadata path.
    setMarker: async (agentId, resumeAtIso) => {
      await agentManager.updateLimitResumeMarker(agentId, resumeAtIso);
    },
    sendResume: async (agentId, prompt, stillWanted, consume) => {
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
          !agentManager.canRunUnscopedLimitResume(agentId)
        )
          throw new Error("Unscoped limit resume refused");
      };
      checkCurrent();
      const finalCheck = createFinalInputCheck(checkCurrent, consume);
      // Refusal checks repeat after provider preparation; only the concrete native send consumes.
      void agentManager
        .runAgent(agentId, prompt, { [FINAL_INPUT_CHECK]: finalCheck })
        .catch((error: unknown) => {
          logger.warn({ err: error, agentId }, "Auto-resume turn failed");
        });
      await waitForFinalInputHandoff(finalCheck);
    },
    onError: (error) => logger.warn({ err: error }, "Auto-resume step failed"),
  });
  service.start();
  service.onStop(
    agentManager.subscribe(
      (event) =>
        void service
          .onAgentEvent(event)
          .catch((e) => logger.warn({ err: e }, "Auto-resume event failed")),
      { replayState: false },
    ),
  );
  return service;
}

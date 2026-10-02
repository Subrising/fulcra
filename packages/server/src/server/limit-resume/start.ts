import type { Logger } from "pino";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { LIMIT_RESUME_AT_LABEL, LimitResumeService } from "./service.js";

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
      const live = agentManager.getAgent(agentId);
      if (live) {
        return {
          labels: live.labels,
          archived: false,
          busy: agentManager.hasInFlightRun(agentId),
        };
      }
      const record = await agentStorage.get(agentId);
      if (!record) return null;
      return { labels: record.labels ?? {}, archived: Boolean(record.archivedAt), busy: false };
    },
    // An empty value clears the marker; labels cannot be deleted through the metadata path.
    setMarker: async (agentId, resumeAtIso) => {
      await agentManager.updateAgentMetadata(agentId, {
        labels: { [LIMIT_RESUME_AT_LABEL]: resumeAtIso ?? "" },
      });
    },
    sendResume: async (agentId, prompt) => {
      // After a restart the session may not be loaded; load it like a client message would.
      await ensureAgentLoaded(agentId, { agentManager, agentStorage, logger });
      // Start the turn and return: the turn can run for a long time and must not hold the queue.
      void agentManager.runAgent(agentId, prompt).catch((error: unknown) => {
        logger.warn({ err: error, agentId }, "Auto-resume turn failed");
      });
    },
    onError: (error) => logger.warn({ err: error }, "Auto-resume step failed"),
  });
  service.start();
  agentManager.subscribe(
    (event) =>
      void service
        .onAgentEvent(event)
        .catch((e) => logger.warn({ err: e }, "Auto-resume event failed")),
    { replayState: false },
  );
  return service;
}

// RELEASE CHECK (FU-736): run before every release that changes report-up or the timeline.
// A worker on one computer whose lead is on another computer that cannot be reached must not cause repeated
// notices. On 0.2.44 one worker on the Air got about 7,750 notices in one day (one turn every 3-4 s).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { ReportUpService } from "./report-up.js";

// Fixed numbers, so this check also runs against an older report-up.ts.
const NOTICE_REPEAT_LIMIT = 3;
const NOTICE_REPEAT_WINDOW_MS = 60 * 60_000;

const WORKER = "22222222-2222-4222-8222-222222222222";
const MINI_LEAD = "11111111-1111-4111-8111-111111111111";

describe("release check FU-736", () => {
  test("release check FU-736: an unreachable cross-host lead causes no repeated notices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-check-fu736-"));
    try {
      const start = Date.now();
      const clock = { now: start };
      const worker = {
        id: WORKER,
        title: "Air worker",
        labels: { [REPORTS_TO_LABEL]: `${MINI_LEAD}@srv_mini` },
        lifecycle: "idle",
        lastMessage: "DONE step 0",
      };
      const timers: Array<() => void> = [];
      const notices: Array<{ to: string; at: number }> = [];
      const sends: string[] = [];
      const manager = {
        getAgent: (id: string) => (id === WORKER ? worker : null),
        listAgents: () => [worker],
        hasInFlightRun: () => false,
        getPendingPermissions: () => [],
        getLastAssistantMessage: async () => worker.lastMessage,
        nativeReportOwnsFinish: () => false,
        archiveLedgerTransferOffer: async () => "",
      } as unknown as AgentManager;
      const storage = {
        get: async (id: string) => (id === WORKER ? worker : null),
        getCached: (id: string) => (id === WORKER ? worker : null),
        getFinishNotice: async () => null,
        list: async () => [worker],
      } as unknown as AgentStorage;
      const service = new ReportUpService({
        agentManager: manager,
        agentStorage: storage,
        isEnabled: () => false,
        localServerId: "srv_air",
        logger: createTestLogger(),
        now: () => clock.now,
        statePath: join(dir, "report-up.json"),
        readLedger: () => [],
        setTimer: (run) => timers.push(run),
        // The lead's computer and the main assistant cannot be reached.
        remoteSend: async (identifier) => {
          sends.push(identifier);
          throw new Error("ssh: connect to host mini: Connection refused");
        },
        deliver: async (to) => {
          notices.push({ to, at: clock.now });
        },
      });
      const stream = (event: object) =>
        service.onEvent({ type: "agent_stream", agentId: WORKER, event } as AgentManagerEvent);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
      // Three hours: a turn every 3 minutes. Every second turn is the worker's answer to a notice, in the
      // v0.15.0 timeline shape. The other turns are new work with a new result.
      for (let n = 0; n < 60; n++) {
        const answer = n % 2 === 1;
        if (!answer) worker.lastMessage = `DONE step ${n}`;
        stream({ type: "turn_started", provider: "claude" });
        stream({
          type: "timeline",
          provider: "claude",
          item: answer
            ? {
                type: "tool_call",
                callId: `paseo-system:${n}`,
                name: "heartbeat",
                status: "completed",
                error: null,
                detail: { type: "plain_text", text: "notice" },
                metadata: { submittedMessageId: `daemon-finish:report-up:${n}` },
              }
            : { type: "user_message", text: `do step ${n}` },
        });
        stream({ type: "turn_completed", provider: "claude" });
        await settle();
        while (timers.length) timers.shift()!();
        await settle();
        clock.now += 3 * 60_000;
      }
      const toWorker = notices.filter((notice) => notice.to === WORKER);
      for (const notice of toWorker) {
        const inHour = toWorker.filter(
          (other) => other.at >= notice.at && other.at < notice.at + NOTICE_REPEAT_WINDOW_MS,
        );
        expect(inHour.length).toBeLessThanOrEqual(NOTICE_REPEAT_LIMIT);
      }
      // 30 results in 3 hours: at most one notice per result, and the cap holds the rest.
      expect(toWorker.length).toBeLessThanOrEqual(2 * NOTICE_REPEAT_LIMIT);
      // The daemon retries each result at most twice; it never loops.
      expect(sends.filter((id) => id === MINI_LEAD).length).toBeLessThanOrEqual(30 * 3);
      service.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

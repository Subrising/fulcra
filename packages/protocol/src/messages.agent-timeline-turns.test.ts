import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

// The shapes a client or daemon from before the turn index shipped would parse with.
const OldEditDetailSchema = z.object({
  type: z.literal("edit"),
  filePath: z.string(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  unifiedDiff: z.string().optional(),
});
const OldFetchTimelineRequestSchema = z.object({
  type: z.literal("fetch_agent_timeline_request"),
  agentId: z.string(),
  requestId: z.string(),
  direction: z.enum(["tail", "before", "after"]).optional(),
  limit: z.number().int().nonnegative().optional(),
});
const OldDeleteAgentRequestSchema = z.object({
  type: z.literal("delete_agent_request"),
  agentId: z.string(),
  requestId: z.string(),
});

const multiFileEdit = {
  type: "tool_call",
  callId: "patch-1",
  name: "apply_patch",
  status: "completed",
  error: null,
  detail: {
    type: "edit",
    filePath: "src/a.ts",
    unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n",
    files: [
      { path: "src/a.ts", kind: "update", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "src/b.ts", kind: "add" },
    ],
  },
};

const turn = {
  turnId: "turn-1",
  implicit: false,
  seqStart: 1,
  seqEnd: 4,
  startedAt: "2026-09-24T00:00:00.000Z",
  endedAt: "2026-09-24T00:00:03.000Z",
  toolCount: 1,
  files: ["src/a.ts", "src/b.ts"],
  externalFileCount: 0,
};

describe("timeline turn index protocol", () => {
  test("old requests parse unchanged and the new optional fields round-trip", () => {
    const oldFetch = { type: "fetch_agent_timeline_request", agentId: "a", requestId: "r1" };
    expect(SessionInboundMessageSchema.parse(oldFetch)).toEqual(oldFetch);
    const oldDelete = { type: "delete_agent_request", agentId: "a", requestId: "r2" };
    expect(SessionInboundMessageSchema.parse(oldDelete)).toEqual(oldDelete);

    const byTurn = { ...oldFetch, turnId: "turn-1", direction: "after", limit: 0 };
    expect(SessionInboundMessageSchema.parse(byTurn)).toEqual(byTurn);
    const purgingDelete = { ...oldDelete, purgeHistory: true };
    expect(SessionInboundMessageSchema.parse(purgingDelete)).toEqual(purgingDelete);

    // A daemon that predates the fields still accepts the messages; it ignores them, which is why
    // clients gate on server_info.features.agentTimelineTurnIndex.
    expect(OldFetchTimelineRequestSchema.parse(byTurn)).not.toHaveProperty("turnId");
    expect(OldDeleteAgentRequestSchema.parse(purgingDelete)).not.toHaveProperty("purgeHistory");
  });

  test("multi-file edit details keep filePath for clients that predate files", () => {
    const parsed = AgentTimelineItemPayloadSchema.parse(multiFileEdit);
    expect(parsed).toEqual(multiFileEdit);
    expect(OldEditDetailSchema.parse(multiFileEdit.detail)).toEqual({
      type: "edit",
      filePath: "src/a.ts",
      unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n",
    });
  });

  test("the new RPCs parse in both directions", () => {
    for (const request of [
      { type: "agent.timeline.list_turns.request", agentId: "a", requestId: "r", cursor: 100 },
      { type: "agent.timeline.get_file_history.request", agentId: "a", requestId: "r", path: "x" },
      { type: "agent.timeline.purge.request", agentId: "a", requestId: "r" },
    ]) {
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    }

    const responses = [
      {
        type: "agent.timeline.list_turns.response",
        payload: {
          requestId: "r",
          agentId: "a",
          epoch: "e",
          retained: false,
          turns: [turn],
          totalTurns: 1,
          nextCursor: null,
          error: null,
        },
      },
      {
        type: "agent.timeline.get_file_history.response",
        payload: {
          requestId: "r",
          agentId: "a",
          epoch: "e",
          retained: true,
          path: null,
          touches: [
            { seq: 2, turnId: "turn-1", kind: "patch", timestamp: "2026-09-24T00:00:01.000Z" },
          ],
          error: null,
        },
      },
      {
        type: "agent.timeline.purge.response",
        payload: { requestId: "r", agentId: "a", purged: true, error: null },
      },
    ];
    for (const response of responses) {
      expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
      // The generated validator is what clients run on inbound messages.
      const validated = validateWSOutboundMessage({ type: "session", message: response });
      expect(validated.success).toBe(true);
    }
  });

  test("the generated validator accepts a timeline page with a multi-file edit", () => {
    const validated = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "fetch_agent_timeline_response",
        payload: {
          requestId: "r",
          agentId: "a",
          agent: null,
          direction: "tail",
          projection: "projected",
          epoch: "e",
          reset: false,
          staleCursor: false,
          gap: false,
          window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
          startCursor: { epoch: "e", seq: 1 },
          endCursor: { epoch: "e", seq: 1 },
          hasOlder: false,
          hasNewer: false,
          entries: [
            {
              provider: "codex",
              item: multiFileEdit,
              timestamp: "2026-09-24T00:00:00.000Z",
              seqStart: 1,
              seqEnd: 1,
              sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
              collapsed: [],
              turnId: "turn-1",
            },
          ],
          error: null,
        },
      },
    });
    expect(validated.success).toBe(true);
  });

  test("server_info advertises the turn index as an optional feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "daemon",
      features: { agentTimelineTurnIndex: true },
    });
    expect(parsed.features?.agentTimelineTurnIndex).toBe(true);
  });
});

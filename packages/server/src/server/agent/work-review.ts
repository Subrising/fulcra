import type { Logger } from "pino";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { armPromptFinishNotification, sendPromptToAgent } from "./agent-prompt.js";
import type { Approver, Assignment } from "./work-acceptance.js";

// FULCRA(orchestration): FU-349. One review path for the MCP tool (a lead) and the owner RPC (the owner).

export interface WorkReviewInput {
  item: string;
  decision: "approve" | "reject";
  candidateId?: string;
  evidenceDigest?: string;
  milestone?: string;
  findings?: string;
}

export async function reviewWork(
  deps: { agentManager: AgentManager; agentStorage: AgentStorage; logger: Logger },
  input: WorkReviewInput,
  reviewer: Approver,
): Promise<Assignment> {
  const store = deps.agentManager.workAcceptance;
  if (!store) throw new Error("Approve-before-close is not configured on this daemon.");
  if (input.decision === "approve") {
    if (!input.candidateId || !input.evidenceDigest)
      throw new Error("Approval needs candidateId and evidenceDigest.");
    return store.approve(input.item, reviewer, {
      candidateId: input.candidateId,
      evidenceDigest: input.evidenceDigest,
      milestone: input.milestone ?? "milestone",
    });
  }
  if (!input.findings) throw new Error("Rejection needs findings.");
  const rejected = await store.reject(input.item, reviewer, input.findings);
  // The same worker gets the findings and one new finish notice for the assigning lead.
  let rearmed: string | null = null;
  try {
    if (rejected.leadId)
      rearmed = await armPromptFinishNotification({
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        childAgentId: rejected.workerId,
        callerAgentId: rejected.leadId,
        forNextTurn: true,
        logger: deps.logger,
      });
    await sendPromptToAgent({
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      agentId: rejected.workerId,
      prompt: `Review of ${rejected.item} rejected this result. Fix these findings, run the checks again, then submit the new result.\n\n${input.findings}`,
      logger: deps.logger,
    });
  } catch (error) {
    if (rearmed)
      await deps.agentStorage.settleFinishNotice(rejected.workerId, rearmed, "cancelled");
    throw error;
  }
  return rejected;
}

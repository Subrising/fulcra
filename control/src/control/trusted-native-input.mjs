import { randomUUID } from "node:crypto";
import { NativeQueuedMessageReceiptSchema } from "@getpaseo/protocol/native-intercom";
import { DaemonRpcError } from "./client-sdk.mjs";
import { sendPayload, queuedSendPayload, payloadDigest } from "./trusted-contribution.mjs";
const localNoDispatch = new WeakSet();
// Cutover (A1): a Book-routed send refused before dispatch -- by HostNative's own coordinator fences, or by the Book receiver's
// verified reply -- is a definite refusal, as the live controller recorded it. Only that path marks errors; see host-native.mjs.
export const nativeNoDispatch = (error) => {
  if (error && typeof error === "object") localNoDispatch.add(error);
  return error;
};
export const isNativeAdmissionRefusal = (error) =>
  localNoDispatch.has(error) ||
  (error instanceof DaemonRpcError &&
    error.code === "admission_refused" &&
    error.nativeDispatched === false);
// The distribution supplies the authenticated private channel. No public mint endpoint or password fallback.
export function boundNativeInputs({ daemon, issueProvenance, verifyActivation }) {
  if (
    typeof daemon?.invokeRawInput !== "function" ||
    typeof issueProvenance !== "function" ||
    typeof verifyActivation !== "function"
  )
    throw Error("Authenticated controller input channel unavailable");
  const beforeMint = () => {
    try {
      verifyActivation();
    } catch (cause) {
      const error = new Error("Trusted host activation unavailable before capability issuance", {
        cause,
      });
      localNoDispatch.add(error);
      throw error;
    }
  };
  return {
    async send(agentId, text, id, attemptId) {
      beforeMint();
      const messageId = "orca-control:" + id;
      const inputProvenance = await issueProvenance({
        agentId,
        kind: "prompt",
        messageId,
        attemptId,
        payloadDigest: payloadDigest(agentId, "prompt", messageId, sendPayload(text)),
      });
      verifyActivation();
      const reply = await daemon.invokeRawInput(
        {
          type: "send_agent_message_request",
          requestId: randomUUID(),
          agentId,
          text,
          messageId,
          inputProvenance,
          activeTurnBehavior: "interrupt",
        },
        "send_agent_message_response",
      );
      if (reply.accepted !== true)
        throw Error(reply.error ?? "Native dispatch outcome unavailable");
      return reply;
    },
    async sendQueued(agentId, text, id, attemptId) {
      beforeMint();
      const messageId = "orca-control:" + id;
      const inputProvenance = await issueProvenance({
        agentId,
        kind: "prompt",
        messageId,
        attemptId,
        payloadDigest: payloadDigest(agentId, "prompt", messageId, queuedSendPayload(text)),
      });
      verifyActivation();
      const reply = await daemon.invokeRawInput(
        {
          type: "send_agent_message_request",
          requestId: randomUUID(),
          agentId,
          text,
          messageId,
          inputProvenance,
          nativeQueue: true,
        },
        "send_agent_message_response",
      );
      const receipt = NativeQueuedMessageReceiptSchema.parse(reply.nativeReceipt);
      if (
        receipt.messageId !== messageId ||
        reply.accepted !== ["queued", "dispatching", "delivered"].includes(receipt.state)
      )
        throw Error("Native queued receipt correlation unavailable");
      return receipt;
    },
    async permission(agentId, intentId) {
      beforeMint();
      const requestId = "orca-permission:" + intentId,
        response = { behavior: "allow" };
      const inputProvenance = await issueProvenance({
        agentId,
        kind: "permission",
        messageId: requestId,
        attemptId: intentId,
        payloadDigest: payloadDigest(agentId, "permission", requestId, {
          type: "permission",
          requestId,
          response,
        }),
      });
      verifyActivation();
      return daemon.invokeRawInput(
        { type: "agent_permission_response", agentId, requestId, response, inputProvenance },
        "agent_permission_resolved",
      );
    },
    // H7 item 5 (merged from the live lineage): a journaled question answer. Same provenance binding as permission, over
    // the caller's exact response; the daemon admits it only through admitQuestionAnswer (hook-journal-policy.mjs).
    async answer(agentId, intentId, response) {
      beforeMint();
      const requestId = "orca-permission:" + intentId;
      const inputProvenance = await issueProvenance({
        agentId,
        kind: "permission",
        messageId: requestId,
        attemptId: intentId,
        payloadDigest: payloadDigest(agentId, "permission", requestId, {
          type: "permission",
          requestId,
          response,
        }),
      });
      verifyActivation();
      return daemon.invokeRawInput(
        { type: "agent_permission_response", agentId, requestId, response, inputProvenance },
        "agent_permission_resolved",
      );
    },
  };
}

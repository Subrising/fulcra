import { validateIntakeCreation } from "./creation-config.mjs";
// A user-authored intake spends only the app's normal human-owned native route.
export async function createIntakeChat({
  intake,
  project,
  api,
  config,
  deliveryId,
  agentId,
  taskId = null,
  record,
  canReuseContext,
}) {
  if (
    !intake.context ||
    !project.placements.some(
      (p) => p.serverId === intake.context.serverId && p.projectId === intake.context.projectId,
    )
  )
    throw new Error("Choose an existing destination before starting this chat");
  if (intake.conversations.length)
    throw new Error("This delivery is already retained; open or reconcile it instead of replaying");
  if (typeof canReuseContext !== "function" || !canReuseContext(intake.context.serverId))
    throw new Error(
      "This host cannot confirm creation in an existing execution context. Connect or update it before starting this chat.",
    );
  const workspace = api.workspaces.ref(intake.context.workspaceId);
  const current = await workspace.refresh();
  if (
    !current ||
    current.id !== intake.context.workspaceId ||
    current.projectId !== intake.context.projectId ||
    current.archivingAt
  )
    throw new Error("The recorded execution context is unavailable or belongs to another project");
  if (typeof current.workspaceDirectory !== "string" || !current.workspaceDirectory.trim())
    throw new Error("The existing destination directory is not confirmed. No chat was reserved.");
  const snapshot = await api.providers.snapshot({ cwd: current.workspaceDirectory });
  const validatedConfig = validateIntakeCreation({ config, entries: snapshot.entries });
  const confirmed = await workspace.refresh();
  if (
    !confirmed ||
    confirmed.id !== current.id ||
    confirmed.projectId !== current.projectId ||
    confirmed.workspaceDirectory !== current.workspaceDirectory ||
    confirmed.archivingAt
  )
    throw new Error("The existing destination changed during validation. No chat was reserved.");
  // The connection/context may have changed during the metadata read; refuse before reserving.
  if (!canReuseContext(intake.context.serverId))
    throw new Error("Reconnect the destination before starting this retained request.");
  await record({ action: "reserve-chat", deliveryId, agentId });
  try {
    const agent = await workspace.agents.create({
      agentId,
      idempotencyKey: deliveryId,
      clientMessageId: deliveryId,
      config: validatedConfig,
      title: intake.text.slice(0, 120),
      prompt: intake.text,
      labels: { "fulcra.intake": intake.id, "fulcra.role": "implementation" },
    });
    if (agent.id !== agentId) throw new Error("The host returned another conversation identity");
    await record({ action: "chat-result", deliveryId, state: "created", taskId });
    return { serverId: intake.context.serverId, agentId: agent.id };
  } catch (error) {
    // A lost reply is not proof that no chat exists. Never automatically create/send again.
    await record({ action: "chat-result", deliveryId, state: "uncertain", taskId: null });
    throw error;
  }
}
export function intakeRoutingPrompt(intake, workspace) {
  const prompt = `Route this human-authored intake ${intake.id}. This is a routing question only. Do not create projects, workspaces, sessions, worktrees or grant authority. Choose an existing project only when the intent supports it. Reply with JSON {"intakeId":"${intake.id}","projectKey":"an exact alias below"}; otherwise reply with JSON {"intakeId":"${intake.id}","question":"the actual ambiguity for the human to clarify"}.\nProjects: ${JSON.stringify(workspace.projects.map(({ name }, index) => ({ projectKey: `p${index + 1}`, name })))}\nRequest: ${intake.text}`;
  if (new TextEncoder().encode(prompt).byteLength > 16384)
    throw new Error(
      "This retained request is too large for one main assistant routing message. Choose its existing project directly.",
    );
  return prompt;
}
export async function askIntakePrime({
  intake,
  workspace,
  api,
  binding,
  requestId,
  record,
  sendOwned,
  available = true,
}) {
  if (
    !intake.prime ||
    (intake.primeRequest &&
      !["held", "offline", "busy", "unavailable"].includes(intake.primeRequest.state))
  )
    throw new Error("No new main assistant request can be sent for this intake");
  const prompt = intake.primeRequest?.prompt ?? intakeRoutingPrompt(intake, workspace);
  await record({ action: "reserve-prime", requestId, prompt });
  const finish = (state, reply) => record({ action: "prime-result", requestId, state, reply });
  if (binding?.humanHeld || intake.prime.kind === "human-session") {
    await finish(
      "held",
      "The original receiving conversation is held for its human owner. Your intake is retained; open that conversation or choose an existing project.",
    );
    return null;
  }
  if (
    !binding ||
    binding.sessionId !== intake.prime.agentId ||
    binding.humanHeld !== false ||
    binding.session?.mode !== "delegated" ||
    !Number.isSafeInteger(binding.session.generation) ||
    !binding.dispatch?.supported ||
    typeof sendOwned !== "function"
  ) {
    await finish(
      "unavailable",
      "The main assistant’s existing receiving route is not confirmed. Your intake is saved; choose a project or review the original main assistant’s controls.",
    );
    return null;
  }
  if (!available) {
    await finish(
      "offline",
      "The main assistant host is offline. Your intake is saved; no message was sent.",
    );
    return null;
  }
  try {
    const client = typeof api === "function" ? api() : api;
    const prime = client.agents.ref(intake.prime.agentId);
    await prime.refresh();
    const current = prime.current();
    if (
      !current ||
      current.archivedAt ||
      current.providerUnavailable ||
      ["closed", "error"].includes(current.status)
    ) {
      await finish(
        "offline",
        "The original main assistant is unavailable. Open its receiving controls or choose an existing project.",
      );
      return null;
    }
    if (current.status !== "idle") {
      await finish(
        "busy",
        "The main assistant is busy. Your intake is retained; no second reasoning turn was sent.",
      );
      return null;
    }
    const output = await sendOwned({
      method: "operator-native-queue",
      input: {
        sessionId: intake.prime.agentId,
        messageId: requestId,
        text: prompt,
        expectedGeneration: binding.session.generation,
      },
    });
    if (!output.ok) {
      await finish(
        output.dispatched ? "uncertain" : "unavailable",
        "The main assistant request is not confirmed. Open its existing controls; this request will not be resent automatically.",
      );
      return null;
    }
    const delivery = output.result,
      receipt = delivery?.result?.nativeReceipt;
    if (
      delivery?.id !== requestId ||
      delivery.session !== intake.prime.agentId ||
      receipt?.messageId !== `orca-control:${requestId}`
    ) {
      await finish(
        "uncertain",
        "The original main assistant delivery could not be correlated. Inspect it rather than resend.",
      );
      return null;
    }
    if (receipt.state !== "delivered") {
      await finish(
        receipt.state === "queued" ? "queued" : "unavailable",
        "Your request remains with the original main assistant’s receiving route. A queue acknowledgement is not a routing answer.",
      );
      return null;
    }
    if (!receipt.providerTurnId) {
      await finish(
        "uncertain",
        "Main assistant acceptance is not confirmed. Your retained request and original main assistant remain available.",
      );
      return null;
    }
    const result = await prime.waitForFinish(60000);
    if (result.status !== "idle" || !result.lastMessage) {
      await finish(
        "uncertain",
        result.error ??
          "No confirmed routing reply. Open the original main assistant conversation; no resend was made.",
      );
      return null;
    }
    let reply;
    try {
      reply = JSON.parse(result.lastMessage.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {}
    if (reply?.intakeId !== intake.id) {
      await finish(
        "uncertain",
        "The reply does not name this intake. Keep the same request and inspect the original main assistant conversation.",
      );
      return null;
    }
    await finish("answered", result.lastMessage);
    return result.lastMessage;
  } catch (error) {
    await finish(
      "uncertain",
      "The main assistant request could not be confirmed. Keep the same identity and open the original conversation.",
    );
    throw error;
  }
}

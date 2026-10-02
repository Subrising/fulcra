// Preserve the installed native boundaries when staging the maintained Paseo build.
// These anchors mirror deploy-admission.mjs and permission-overlay.py; the newer
// Session already replies to modern clients, so only legacy clients need an emit.
export function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw Error("Native release hook anchor changed");
  return text.replace(from, () => to);
}
export function bindGuardHome(text, home) {
  const original =
    "const HOME = process.env.ORCA_ADMISSION_HOME ?? '/path/to/unconfigured/controller';";
  return replaceOnce(text, original, `const HOME = ${JSON.stringify(home)};`);
}
// The one module every Claude Agent SDK process is started from, and its patch. permission-overlay.py applies the
// same text (patch_deny_module); the boundary test proves both routes produce identical bytes.
export const CLAUDE_QUERY_MODULE = "agent/providers/claude/query.js";
export const CLAUDE_QUERY_IMPORT = "denyClaudeQueryOptions as orcaDenyClaudeQueryOptions";
export const denyClaudeLaunch = (launch) =>
  launch.replace(
    "(input.options, context)",
    "(orcaDenyClaudeQueryOptions(input.options), context)",
  );
export function patchNativeHooks(sources, guardPath) {
  const fence = "orcaAdmissionGuard({ id: agentId }, '', undefined, false);";
  const permission =
    "    async respondToPermission(agentId, requestId, response) {\n        const agent = this.requireAgent(agentId);";
  const send = "export async function sendPromptToAgent(params) {";
  const start =
    "export async function startAgentRun(agentManager, agentId, prompt, logger, options) {\n    const snapshot = agentManager.getAgent(agentId);";
  const interrupt = "    async interruptAgentIfRunning(agentId) {";
  const fetch =
    "        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (!agent) {";
  const response =
    "            await respondToAgentPermission({\n                agentManager: this.agentManager,\n                agentId,\n                requestId,\n                response,\n                logger: this.sessionLogger,\n            });";
  const cancel = "export async function cancelAgentRunCommand(dependencies, agentId) {";
  // R-F-A1: the Claude SDK launch choke point; see denyClaudeQueryOptions in admission-guard.mjs.
  const launch = "        options: applyRuntimeSettingsToClaudeOptions(input.options, context),";
  const patches = {
    "agent/agent-manager.js": [
      [
        permission,
        permission + "\n        requestId = orcaPermissionGuard(agent, requestId, response);",
      ],
    ],
    "agent/agent-prompt.js": [
      [
        send,
        send +
          "\n    if (!params.messageId?.startsWith('orca-control:')) orcaAdmissionGuard({ id: params.agentId }, '', undefined, false);",
      ],
      [
        start,
        start +
          "\n    orcaAdmissionGuard(snapshot, prompt, options?.runOptions, agentManager.hasInFlightRun(agentId));",
      ],
    ],
    "session.js": [
      [interrupt, interrupt + "\n        " + fence],
      [
        fetch,
        "        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (agent) agent.labels = { ...agent.labels, 'orca.native-barrier': JSON.stringify(orcaAdmissionObservation(resolved.agentId)) };\n        if (!agent) {",
      ],
      [
        response,
        response +
          '\n            if (requestId.startsWith("orca-permission:") && !this.delivery.isModern(this.delivery.currentSource)) this.emit({ type: "agent_permission_resolved", payload: { agentId, requestId, resolution: response } });',
      ],
    ],
    "agent/lifecycle-command.js": [[cancel, cancel + "\n    " + fence]],
    [CLAUDE_QUERY_MODULE]: [[launch, denyClaudeLaunch(launch)]],
  };
  return Object.fromEntries(
    Object.entries(patches).map(([name, pairs]) => {
      let text = sources[name];
      if (
        typeof text !== "string" ||
        text.includes("orcaAdmissionGuard") ||
        text.includes("orcaPermissionGuard") ||
        text.includes("orcaDenyClaudeQueryOptions")
      )
        throw Error("Native release hook input missing or already patched");
      for (const [from, to] of pairs) text = replaceOnce(text, from, to);
      if (name === "agent/agent-manager.js") {
        // Skipping the rewiring is correct for a build with no refresh RPC to fence, and silent skipping was
        // indistinguishable from a build where the symbol moved. The two states ARE distinguishable: if the
        // class still assigns mcpRefreshAdmission there is something to fence, so an absent refreshAgentMcp
        // means the symbol was renamed rather than removed, and the patch would report success with no fence.
        // Neither dist on this machine is in that state -- the pristine one has both, the deployed one is
        // already patched -- so this is forward-looking and currently unreachable.
        const anchor = "        this.mcpRefreshAdmission = options.mcpRefreshAdmission;";
        const assigns = text.includes(anchor),
          rpc = text.includes("refreshAgentMcp(");
        if (assigns && !rpc)
          throw Error(
            "Native release hook input assigns mcpRefreshAdmission but exposes no refreshAgentMcp; the refresh fence would be skipped silently",
          );
        if (rpc)
          text = replaceOnce(
            text,
            anchor,
            "        this.mcpRefreshAdmission = orcaMcpRefreshAdmission;",
          );
      }
      const imports =
        name === "agent/agent-manager.js"
          ? "permissionGuard as orcaPermissionGuard, mcpRefreshAdmission as orcaMcpRefreshAdmission"
          : name === CLAUDE_QUERY_MODULE
            ? CLAUDE_QUERY_IMPORT
            : "guard as orcaAdmissionGuard, observation as orcaAdmissionObservation";
      return [name, `import { ${imports} } from ${JSON.stringify(guardPath)};\n` + text];
    }),
  );
}

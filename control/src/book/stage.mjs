// The SSH Book transport is retired (0.2.7). Only the patch helpers stay; staging and applying a receiver refuse.
function once(text, before, after) {
  if (text.split(before).length !== 2)
    throw Error("Book native patch anchor drift: " + before.slice(0, 70));
  return text.replace(before, after);
}
export function patchBookMcpRefreshAdmission(text) {
  if (!text.includes("refreshAgentMcp(")) return text; // Older native builds cannot expose this operation.
  const bound = "        this.mcpRefreshAdmission = orcaBookMcpRefreshAdmission;";
  if (text.includes(bound)) return once(text, bound, bound);
  return once(text, "        this.mcpRefreshAdmission = options.mcpRefreshAdmission;", bound);
}
export function patchBookPermissionAcknowledgement(text) {
  const accepted =
    "            await respondToAgentPermission({\n                agentManager: this.agentManager,\n                agentId,\n                requestId,\n                response,\n                logger: this.sessionLogger,\n            });";
  const ack =
    '\n            if (requestId.startsWith("orca-permission:")) this.emit({ type: "agent_permission_resolved", payload: { agentId, requestId, resolution: response } });';
  once(text, accepted, accepted);
  const count = text.split(ack).length - 1;
  if (count > 1) throw Error("Book permission acknowledgement duplicated");
  return count === 1
    ? once(text, accepted + ack, accepted + ack)
    : once(text, accepted, accepted + ack);
}
export function patchBookModules(files, entry) {
  const out = { ...files, "session.js": patchBookPermissionAcknowledgement(files["session.js"]) },
    add = (name, before, after) => {
      out[name] = once(out[name], before, after);
    };
  add(
    "session.js",
    "    async interruptAgentIfRunning(agentId) {",
    '    async interruptAgentIfRunning(agentId) {\n        orcaBookGuard({id:agentId},"",undefined,false);',
  );
  const fetch =
    "        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (!agent) {";
  add(
    "session.js",
    fetch,
    '        const agent = await this.getAgentPayloadById(resolved.agentId);\n        if (agent) agent.labels = {...agent.labels, "orca.native-barrier": JSON.stringify(orcaBookObservation(resolved.agentId))};\n        if (!agent) {',
  );
  add(
    "agent/lifecycle-command.js",
    "export async function cancelAgentRunCommand(dependencies, agentId) {",
    'export async function cancelAgentRunCommand(dependencies, agentId) {\n    orcaBookGuard({id:agentId},"",undefined,false);',
  );
  const manager = "agent/agent-manager.js";
  for (const [anchor, id] of [
    ["    async archiveSnapshot(agentId, archivedAt) {", "agentId"],
    ["    closeAgent(agentId) {", "agentId"],
    ["    async archiveAgent(agentId) {", "agentId"],
    ["    async cancelAgentRun(agentId) {", "agentId"],
  ])
    add(manager, anchor, anchor + `\n        orcaBookGuard({id:${id}},"",undefined,false);`);
  const final =
    "        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            const result = await agent.session.startTurn(prompt, options);";
  add(
    manager,
    final,
    '        const { agent, agentId, pendingRun, prompt, options } = params;\n        try {\n            orcaBookGuard(agent,prompt,options,pendingRun.settled || Boolean(agent.activeForegroundTurnId),true);\n        } catch(error) {\n            pendingRun.start={status:"failed",error:error.message};\n            this.emitState(agent);\n            this.runs.settleForegroundRun(agentId,pendingRun.token);\n            throw error;\n        }\n        try {\n            const result = await agent.session.startTurn(prompt, options);',
  );
  for (const [anchor, agent] of [
    [
      "    streamAgent(agentId, prompt, options) {\n        const existingAgent = this.requireSessionAgent(agentId);",
      "existingAgent",
    ],
    [
      "    async replaceAgentRun(agentId, prompt, options) {\n        const snapshot = this.requireAgent(agentId);",
      "snapshot",
    ],
    [
      "    async steerOrReplaceActiveTurn(agentId, prompt, options) {\n        const agent = this.requireSessionAgent(agentId);",
      "agent",
    ],
  ])
    add(
      manager,
      anchor,
      anchor + `\n        orcaBookGuard(${agent},prompt,options,this.hasInFlightRun(agentId));`,
    );
  const permission =
    "    async respondToPermission(agentId, requestId, response) {\n        const agent = this.requireAgent(agentId);";
  add(
    manager,
    permission,
    permission + "\n        requestId = orcaBookPermissionGuard(agent,requestId,response);",
  );
  out[manager] = patchBookMcpRefreshAdmission(out[manager]);
  const prompt = "agent/agent-prompt.js",
    start =
      "export async function startAgentRun(agentManager, agentId, prompt, logger, options) {\n    const snapshot = agentManager.getAgent(agentId);";
  add(
    prompt,
    start,
    start +
      "\n    orcaBookGuard(snapshot,prompt,options?.runOptions,agentManager.hasInFlightRun(agentId));",
  );
  const send = "export async function sendPromptToAgent(params) {";
  add(
    prompt,
    send,
    send +
      '\n    if (!params.messageId?.startsWith("orca-control:")) orcaBookGuard({id:params.agentId},"",undefined,false);',
  );
  const archived =
    "    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt) {";
  add(
    prompt,
    archived,
    '    const record = await params.agentStorage.get(params.agentId);\n    if (record?.archivedAt && params.messageId?.startsWith("orca-control:")) throw Error("Orca native admission refused archived Book session");\n    if (record?.archivedAt) {',
  );
  for (const name of Object.keys(out))
    out[name] =
      `import {guard as orcaBookGuard,observation as orcaBookObservation,permissionGuard as orcaBookPermissionGuard,mcpRefreshAdmission as orcaBookMcpRefreshAdmission} from ${JSON.stringify(entry)};\n` +
      out[name];
  return out;
}
const RETIRED = "Book receiver staging is retired with the SSH transport (0.2.7).";
export function stage(_profileFile, _directory, _previousStage) {
  throw new Error(RETIRED);
}
export function apply(_directory, _side) {
  throw new Error(RETIRED);
}

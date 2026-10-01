// Cutover A2: the ONLY controller methods the conversation management route may invoke -- exactly the writes the
// OpenClaw-authorised conversation client issued on the legacy operator lane. Reads stay on the read lane. Frozen, and
// shared by the plugin handler (server/operator-invoke.mjs), its contract and the client adapter.
export const OPERATOR_INVOKE_METHODS = Object.freeze([
  "create",
  "management-prepare",
  "manager-grant",
  "manager-resume",
  "recover",
  "takeover",
  "task-allowance-set",
  "handback",
  "observe",
  "operator-native-queue",
]);
export const OPERATOR_INVOKE_RPC = "organization.operator-invoke";

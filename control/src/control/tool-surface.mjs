import { fileURLToPath } from "node:url";
// H6 item 5 (G5 from the Command Centre). A session's Orca tool surface -- the orca-supervisor MCP server it runs and
// the tools its policy preapproves -- was fixed at creation: the server's args name inbox.mjs INSIDE the controller
// release that created the session, and the preapproved list is the one that release knew. So a seat created before
// H5 kept running an H4 inbox.mjs with no role_inspect_session / role_send_session, and its policy did not preapprove
// them either. `roleToolsVersion: '1'` could not show it: G7/G8 added tools without changing that marker.
//
// This module is the single definition of the surface, used both at creation (native.create) and to bring an existing
// session up to date (native.refreshTools, through the daemon's fenced agent.mcp.refresh). TOOL_SURFACE is a digest of
// everything that is the same for every session of this release -- the server command and path, and the preapproved
// tools -- so "is this session current" is an exact comparison, not a version someone must remember to bump.
import { createHash } from "node:crypto";
import { portable } from "../portable-config.mjs";
import { canonicalMemoryConfig, CANONICAL_MEMORY_ENTRY } from "../canonical-memory-route.mjs";
import { ROLE_TOOLS } from "./grant-file.mjs";
import { CONTROLLER_HOME as HOME } from "./installation-settings.mjs";

export const SUPERVISOR_SERVER = "orca-supervisor",
  MEMORY_SERVER = "orca-canonical";
export const MANAGER_TOOLS = [
  "manager_workers",
  "manager_create_worker",
  "manager_inspect_worker",
  "manager_assign_worker",
];
export const INBOX_TOOLS = ["supervisor_inbox", "supervisor_acknowledge"];
export const MEMORY_TOOLS = ["shared_memory_search", "shared_memory_read"];
export const INBOX = fileURLToPath(new URL("./inbox.mjs", import.meta.url));
const COMMAND = process.execPath;

// The per-session server: the release's inbox.mjs, with this session's grant paths. Deterministic per-session paths
// only -- a grant file does not exist until it is issued, and until then every tool refuses; naming a path grants nothing.
export function supervisorServer(messageId) {
  return {
    type: "stdio",
    command: COMMAND,
    args: [INBOX],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(portable ? { ORCA_HOME: portable.home } : {}),
      ORCA_INBOX_FILE: HOME + "/grants/inbox/" + messageId + ".json",
      ORCA_MANAGER_FILE: HOME + "/grants/manager/" + messageId + ".json",
      ORCA_ROLE_FILE: HOME + "/grants/role/" + messageId + ".json",
    },
  };
}
// The preapproved tools, in creation order. The memory server's tools only when the session has that server: the
// daemon checks every preapproval against the servers in the resulting config.
export function toolPolicy({ memory = true } = {}) {
  const mcp = (server, tool) => ({ kind: /** @type {const} */ ("mcp"), server, tool });
  return {
    preapproved: [
      ...MANAGER_TOOLS.map((t) => mcp(SUPERVISOR_SERVER, t)),
      ...INBOX_TOOLS.map((t) => mcp(SUPERVISOR_SERVER, t)),
      ...ROLE_TOOLS.map((t) => mcp(SUPERVISOR_SERVER, t)),
      ...(memory ? MEMORY_TOOLS.map((t) => mcp(MEMORY_SERVER, t)) : []),
    ],
  };
}
export const TOOL_SURFACE = createHash("sha256")
  .update(
    JSON.stringify({
      command: COMMAND,
      inbox: INBOX,
      memory: CANONICAL_MEMORY_ENTRY,
      preapproved: toolPolicy().preapproved,
    }),
  )
  .digest("hex")
  .slice(0, 16);

// H6 item 5. Brings an existing session's Orca tool surface to this release's (tool-surface.mjs) through the daemon's
// fenced agent.mcp.refresh: expected {provider, sessionId, configRevision} from the daemon's own state, only the
// owned supervisor and memory entries replaced (other servers preserved), and the tool policy replaced in the same refresh.
// The daemon refuses a busy, stale or unsupported session, and its admission guard (mcpRefreshAdmission) refuses one
// that is not a live, delegated, quiescent session. History is kept: the provider session is resumed, not replaced.
export class ToolRefreshUnsupported extends Error {}
// verify is the native adapter's verifyActivation (injected so this stays free of the pinned SDK and the live daemon).
export async function refreshToolsFor(agent, messageId, verify) {
  verify();
  if (typeof agent?.getMcpRefreshState !== "function" || typeof agent?.refreshMcp !== "function")
    throw new ToolRefreshUnsupported(
      "The pinned controller client SDK predates agent MCP refresh; re-pin it to a client built from the current product (packages/client) to refresh tool surfaces",
    );
  const state = await agent.getMcpRefreshState();
  if (!state) throw Error("The daemon does not hold this session");
  if (!state.supported || !state.sessionId)
    throw Error(
      `This session cannot refresh its MCP servers in place (lifecycle ${state.lifecycle})`,
    );
  if (state.lifecycle !== "idle") throw Error("Tool refresh waits for an idle session");
  const result = await agent.refreshMcp({
    expected: {
      provider: state.provider,
      sessionId: state.sessionId,
      configRevision: state.configRevision,
    },
    changes: {
      [SUPERVISOR_SERVER]: supervisorServer(messageId),
      ...(state.mcpServerNames.includes(MEMORY_SERVER)
        ? { [MEMORY_SERVER]: canonicalMemoryConfig(state.provider) }
        : {}),
    },
    toolPolicy: toolPolicy({ memory: state.mcpServerNames.includes(MEMORY_SERVER) }),
  });
  verify();
  if (result.outcome !== "refreshed" && result.outcome !== "unchanged")
    throw Error(
      `The daemon ${result.outcome} the tool refresh (${result.reason ?? "no reason given"})`,
    );
  return { outcome: result.outcome, surface: TOOL_SURFACE };
}

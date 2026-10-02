import fs from "node:fs";
import { uuid } from "./authority.mjs";
// Three separate scoped grants, each its own narrow capability and its own directory. The operator secret is
// never among them, and a role grant drives no worker any more than a manager grant speaks on a seat.
// The role tool surface, named once. native.mjs preapproves exactly this list and inbox.mjs registers
// exactly this list; a tool present in one and not the other is unreachable in practice while every
// advertisement assertion still passes, so the two are tied together here rather than kept in step by hand.
export const ROLE_TOOLS = [
  "role_status",
  "role_channels",
  "role_thread",
  "role_message",
  "role_mark_read",
  "role_request_channel",
  "role_close_channel",
  "role_project_sessions",
  "role_job_directory",
  "role_start_session",
  "role_accept_session",
  "role_decline_session",
  "role_inspect_session",
  "role_send_session",
  "role_decision_ask",
  "role_decision_status",
  "role_decision_withdraw",
  "role_brief_publish",
  // Fulcra J8 Environments (CONTRACTS §6): the four role-lane calls, scoped to the caller's own project (J8-3).
  "role_environments",
  "role_environment_propose",
  "role_promotion_create",
  "role_promotion_ask",
];
export const LANES = {
  "manager-": ["manager", "ORCA_MANAGER_FILE"],
  "bindings-": ["role", "ORCA_ROLE_FILE"],
  "channels-": ["role", "ORCA_ROLE_FILE"],
  "roles-": ["role", "ORCA_ROLE_FILE"],
};
export const grantLane = (method) =>
  Object.entries(LANES).find(([prefix]) => method.startsWith(prefix))?.[1] ?? [
    "inbox",
    "ORCA_INBOX_FILE",
  ];
export function readGrant(home, method, env = process.env) {
  const [lane, variable] = grantLane(method),
    file = env[variable] ?? "";
  const report =
    ["events-inbox", "events-ack"].includes(method) && file.startsWith(home + "/grants/report/");
  const root = home + "/grants/" + (report ? "report" : lane) + "/";
  if (
    !file.startsWith(root) ||
    !uuid(file.slice(root.length, -5)) ||
    !file.endsWith(".json") ||
    fs.realpathSync(file) !== file
  )
    throw Error("No explicit supervisor grant");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  let grant;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) throw Error("Invalid inbox grant");
    grant = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
  if (report) {
    if (
      Object.keys(grant).sort().join() !== "capability,epoch,kind,sessionId" ||
      grant.kind !== "report" ||
      !uuid(grant.epoch) ||
      !uuid(grant.sessionId) ||
      !/^report1\.[A-Za-z0-9_-]{43}$/.test(grant.capability)
    )
      throw Error("Invalid report grant");
  } else if (
    !uuid(grant.sessionId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(grant.capability) ||
    grant.kind === "report"
  )
    throw Error("Invalid inbox grant");
  return grant;
}

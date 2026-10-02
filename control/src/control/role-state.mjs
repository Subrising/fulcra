// Read-only state printer for driving the prime -> project -> worker walkthrough by hand.
// It PRINTS where you are between steps. It performs no step: it creates no session, sends no message,
// opens no channel and mutates nothing. Every call it makes is an operator read.
//
//   node src/control/role-state.mjs [<projectId>]
//
// With a projectId it also prints that project's projection, which is the click-a-project view.
import { portable } from "../portable-config.mjs";
import { controlHome, operatorSecret, reader } from "./control-read.mjs";
import { describeSessionDefaults, settingsStatus } from "./installation-settings.mjs";

const HOME = controlHome();
const projectId = process.argv.find((a) => /^[a-f0-9]{8}-/.test(a)) ?? null;
// Every method below is a pure read. Nothing else may be added to this list.
const READS = [
  "bindings-status",
  "roles-allowances",
  "roles-session-requests",
  "channels-status",
  "channels-requests",
  "bindings-project",
  "session-defaults",
];

const ask = reader({ home: HOME, reads: READS });
const operator = operatorSecret(HOME);
const short = (id) => (typeof id === "string" && id.length > 12 ? id.slice(0, 8) : (id ?? "-"));
const line = (...parts) => console.log("   " + parts.join("  "));

const seats = await ask("bindings-status", operator);
console.log("\n== SEATS ==");
if (seats.__error) line("error:", seats.__error);
else if (!seats.bindings?.length) line("(none assigned)");
else
  for (const b of seats.bindings) {
    line(
      `${b.role}/${b.seat}`.padEnd(48),
      `rev=${b.revision}`,
      `session=${short(b.sessionId)}`,
      `mode=${b.session?.mode ?? "-"}`,
      `task=${short(b.task)}`,
      b.sessionGenerationChanged ? "GENERATION CHANGED" : "",
      b.dispatch?.supported === false ? `UNREACHABLE: ${b.dispatch.reason}` : "",
    );
  }
if (seats.error) line("controller lastError:", JSON.stringify(seats.error));

const allowances = await ask("roles-allowances", operator);
console.log(
  "\n== SESSION ALLOWANCES ==  (a seat with none can do nothing until roles-allowance-set)",
);
if (allowances.__error) line("error:", allowances.__error);
else if (!allowances.allowances?.length) line("(no seats)");
else
  for (const a of allowances.allowances)
    line(
      `${a.role}/${a.seat}`.padEnd(48),
      `rev=${a.seatRevision ?? "-"}`,
      `used=${a.used}/${a.maxSessions ?? "-"}`,
      `remaining=${a.remaining}`,
      a.blocked ? `BLOCKED: ${a.blocked}` : "ok",
    );

const requests = await ask("roles-session-requests", operator);
console.log(
  "\n== SESSION REQUESTS ==  (pending means the seat has not been woken yet; notified means it has)",
);
if (requests.__error) line("error:", requests.__error);
else if (!requests.requests?.length) line("(none)");
else
  for (const r of requests.requests)
    line(
      short(r.requestId),
      r.state.padEnd(9),
      `seat=${r.seat}`,
      `task=${short(r.taskId)}`,
      r.provider,
      `attempts=${r.attempts}`,
      `session=${short(r.sessionId)}`,
      r.failure ? `reason: ${r.failure}` : "",
    );

const channels = await ask("channels-status", operator);
console.log("\n== CHANNELS ==");
if (channels.__error) line("error:", channels.__error);
else if (!channels.channels?.length) line("(none)");
else
  for (const c of channels.channels)
    line(
      short(c.channelId),
      c.state.padEnd(7),
      `${c.primeSeat} <-> ${short(c.projectSeat)}`,
      `used=${c.used}/${c.maxMessages}`,
      `expires=${c.expiresAt}`,
      c.sendable ? "sendable" : `BLOCKED: ${c.blocked}`,
    );
if (channels.messages?.length) {
  console.log("\n== CHANNEL MESSAGES ==  (newest first)");
  for (const m of channels.messages.slice(0, 10))
    line(
      short(m.messageId),
      m.state.padEnd(10),
      `${m.fromSeat} -> ${m.toSeat}`,
      m.readAt ? `read: ${m.readNote}` : "unread",
      m.failure ? `failure: ${m.failure}` : "",
    );
}

if (projectId) {
  const view = await ask("bindings-project", operator, projectId);
  console.log(`\n== PROJECT ${short(projectId)} ==`);
  if (view.__error) line("error:", view.__error);
  else {
    line(
      "membership:",
      view.project.membership.known
        ? `known, ${view.project.membership.memberTaskCount} member tasks`
        : `UNKNOWN (${view.blockers[0]?.detail ?? "see blockers"})`,
    );
    line(
      "leader:",
      view.leader?.state === "assigned"
        ? `${short(view.leader.sessionId)} on task ${short(view.leader.task)}`
        : "NONE ASSIGNED",
    );
    line(
      "progress:",
      view.progress
        ? `${view.progress.recorded} recorded, ${view.progress.unresolved} unresolved, across ${view.progress.memberTasks} tasks`
        : "null (membership unknown — this is correct, not zero)",
    );
    for (const t of view.tasks ?? [])
      for (const s of t.sessions)
        line(
          "  session",
          short(s.id),
          `task=${short(t.taskId)}`,
          `owner=${s.owner?.ownership ?? "-"}`,
          s.owner?.creationRequestId ? `creationRequestId=${short(s.owner.creationRequestId)}` : "",
          s.owner?.parentSession ? `parent=${short(s.owner.parentSession)}` : "",
        );
    for (const n of view.needed ?? [])
      line("  needed ", n.kind, n.sessionId ? short(n.sessionId) : "");
    for (const b of view.blockers ?? [])
      line("  blocker", b.kind, b.sessionId ? short(b.sessionId) : "");
  }
}
const defaults = await ask("session-defaults", operator);
console.log(
  "\n== SESSION DEFAULTS ==  (what a NEW session spawns with, and which file changes it)",
);
for (const l of describeSessionDefaults(defaults, settingsStatus(HOME, portable))) line(l);

console.log("\nRead-only. Nothing above created, sent or changed anything.\n");

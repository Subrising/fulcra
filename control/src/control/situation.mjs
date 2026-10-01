// What is happening right now, and what is stuck -- answered from the controller journal alone.
//
//   node src/control/situation.mjs
//
// A companion to role-state.mjs, which prints every read in a fixed order for driving a walkthrough by
// hand. This one triages: it leads with what is blocked or stuck and who owns it, and it summarises the
// rest. A reviewer should be able to answer "is anything stuck, and whose is it" without scrolling.
//
// Every call it makes is a read. It creates no session, sends no message, opens no channel and mutates
// nothing. The triage below is pure and takes payloads, so it is tested without a running controller.
import { controlHome, operatorSecret, reader } from './control-read.mjs';

export const READS = ['list', 'bindings-status', 'roles-allowances', 'roles-session-requests', 'roles-ownership', 'channels-status', 'history'];

// Not invented here: controller.history sorts exactly these states to the top, which makes them this
// repository's own definition of "not settled yet". Reusing it means the report and the journal cannot
// drift into disagreeing about what counts as outstanding.
export const UNSETTLED = ['intent', 'uncertain', 'prepared', 'queued'];
// Ordered worst first, and the report prints them in this order. BLOCKED means work cannot proceed at all;
// STUCK means something is outstanding and may need a human; ATTENTION is true and worth knowing.
export const SEVERITY = ['BLOCKED', 'STUCK', 'ATTENTION'];
// The only message state that needs nothing from anyone. Kept deliberately short: the cost of a state
// wrongly called settled is silence, and the cost of one wrongly called unsettled is a line of output.
export const MESSAGE_SETTLED = ['delivered'];

// What to DO about each problem, one line each, because a report that diagnoses without prescribing
// leaves the reader to go and find out how to fix it -- which is the gap between a diagnosis and a
// decision.
//
// Every RPC named here is checked against rpc.mjs by a test. A wrong RPC name is worse than no remedy at
// all: it sends someone down a path that does not work, and they will trust it because it was printed.
// Where there is no honest remedy, the line says so instead of inventing one.
export const REMEDIES = {
  readFailed: 'Nothing below is trustworthy until the controller answers; confirm it is running before acting on any of it.',
  allowance: 'Raise it with the roles-allowance-set RPC; until it is raised the seat cannot start new work at all.',
  seatUnreachable: 'The seat names a session that cannot be dispatched to; re-bind it with bindings-assign, or restore the session it names.',
  generationChanged: 'If the replacement session should hold the seat, re-bind it with bindings-assign; otherwise the binding is stale.',
  channelExpired: 'An expired or closed approval cannot be renewed -- open a fresh channel with channels-open.',
  channelSeatChanged: 'The approval names a session and revision that are no longer current; only a fresh channels-open will work.',
  channelSpent: 'The message allowance is fixed when the channel is approved; a fresh channels-open is the only way to add more.',
  messageWaiting: 'The sender is probably waiting; the remedy is a human reading it, not a retry -- resending creates a second message.',
  messageUnsettled: 'It may or may not have arrived. Check the recipient before sending again rather than resending blind.',
  messageUnread: 'Nothing is broken: it arrived and the recipient has not read it yet.',
  sessionRequest: 'Read the failure above before retrying; the request will not progress on its own.',
  deliveryUnsettled: 'Outstanding in the journal. Check the session before resending -- a resend cannot settle the first one.',
  unowned: 'No fix: ownership is recorded at creation and cannot be back-filled. Treat the session as outside the control plane.',
};
// Keyed on the reasons role-channels actually raises, not on invented ones.
const channelRemedy = reason => (/seat changed/.test(reason) ? REMEDIES.channelSeatChanged
  : /allowance reached/.test(reason) ? REMEDIES.channelSpent : REMEDIES.channelExpired);
const short = id => (typeof id === 'string' && id.length > 12 ? id.slice(0, 8) : id ?? '-');

// One function per source, so a payload that arrives empty or errored cannot silently become "all clear".
// A read that failed is itself a problem: not knowing is not the same as nothing being wrong.
export function problems({ seats = {}, allowances = {}, requests = {}, channels = {}, sessions = [], ownership = {}, deliveries = [] } = {}) {
  const out = [];
  // remedy is required, not optional: a problem nobody can act on is a problem half reported.
  const add = (severity, kind, who, detail, remedy) => out.push({ severity, kind, who, detail, remedy });
  for (const [name, payload] of Object.entries({ seats, allowances, requests, channels })) {
    if (payload?.__error) add('BLOCKED', 'read failed', name, `could not read ${name}: ${payload.__error}. Everything below is incomplete.`, REMEDIES.readFailed);
  }
  // A spent allowance is the quiet one: nothing errors, the seat simply stops being able to start work.
  for (const a of allowances.allowances ?? []) {
    if (a.blocked) add('BLOCKED', 'allowance', `${a.role}/${a.seat}`, `${a.blocked} -- this seat can start no new session`, REMEDIES.allowance);
    else if (a.remaining === 0) add('BLOCKED', 'allowance', `${a.role}/${a.seat}`, `spent: ${a.used}/${a.maxSessions} used, 0 remaining. New work will not start and nothing will say so.`, REMEDIES.allowance);
  }
  for (const b of seats.bindings ?? []) {
    if (b.dispatch?.supported === false) add('BLOCKED', 'seat unreachable', `${b.role}/${b.seat}`, `${b.dispatch.reason} -- messages to this seat cannot be delivered`, REMEDIES.seatUnreachable);
    if (b.sessionGenerationChanged) add('ATTENTION', 'generation changed', `${b.role}/${b.seat}`, `session ${short(b.sessionId)} was restarted or replaced since the seat was bound`, REMEDIES.generationChanged);
  }
  for (const c of channels.channels ?? []) {
    if (c.sendable === false) add('BLOCKED', 'channel', `${c.primeSeat} <-> ${short(c.projectSeat)}`, `${c.blocked ?? c.state} (channel ${short(c.channelId)}, ${c.used}/${c.maxMessages} used, expires ${c.expiresAt})`, channelRemedy(c.blocked ?? c.state));
  }
  // An unread refusal is a message someone is waiting on an answer to that will never come.
  //
  // Triaged by what is known to be SETTLED, not by a list of known-bad states, because the live journal
  // carries states this source does not write: the running controller can predate the working tree. Found
  // the hard way -- a real 'refused' message sat in the journal while an enumerate-the-bad-states version
  // of this loop said nothing at all. An unrecognised state is surfaced, never swallowed.
  for (const m of channels.messages ?? []) {
    const who = `${m.fromSeat} -> ${m.toSeat}`, unread = m.readAt ? '' : ' and still unread';
    if (m.failure) add('STUCK', 'message failed', who, `${short(m.messageId)}: ${m.failure}${m.readAt ? '' : ' (still unread)'}`, REMEDIES.messageWaiting);
    else if (UNSETTLED.includes(m.state)) add('STUCK', 'message unsettled', who, `${short(m.messageId)} is ${m.state} -- it may or may not have arrived`, REMEDIES.messageUnsettled);
    else if (!MESSAGE_SETTLED.includes(m.state)) add('STUCK', `message ${m.state}`, who, `${short(m.messageId)} is ${m.state}${unread}. Someone may be waiting on an answer that is not coming.`, REMEDIES.messageWaiting);
    else if (!m.readAt) add('ATTENTION', 'message unread', who, `${short(m.messageId)} was delivered but has not been read`, REMEDIES.messageUnread);
  }
  for (const r of requests.requests ?? []) {
    if (r.failure) add('STUCK', 'session request', `seat ${r.seat}`, `${short(r.requestId)} ${r.state} after ${r.attempts} attempt(s): ${r.failure}`, REMEDIES.sessionRequest);
    else if (r.state === 'pending' && r.attempts > 1) add('STUCK', 'session request', `seat ${r.seat}`, `${short(r.requestId)} still pending after ${r.attempts} attempts`, REMEDIES.sessionRequest);
  }
  for (const d of deliveries) {
    if (UNSETTLED.includes(d.state)) add('STUCK', 'delivery unsettled', `session ${short(d.session)}`, `${short(d.id)} ${d.kind} is ${d.state}`, REMEDIES.deliveryUnsettled);
  }
  // Ownership is how a session is traced to a project and a seat. Without it nothing can say whose this is.
  for (const s of sessions) {
    if (ownership[s.id]?.ownership === 'unknown') add('ATTENTION', 'unowned session', `session ${short(s.id)}`, `no owning project recorded; task ${short(s.task)}.`, REMEDIES.unowned);
  }
  return out.sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
}

// Two different facts, deliberately not merged. `mode` is recorded on the session and says whether it is
// driven by a human or delegated. Ownership says whether a project and seat were recorded when it was
// created. A session can be one without the other, so collapsing them into a single "origin" would state
// something the journal does not.
export function inventory({ sessions = [], ownership = {} } = {}) {
  return sessions.map(s => {
    const o = ownership[s.id] ?? {};
    return { session: s.id, task: s.task, mode: s.mode ?? null, project: o.projectId ?? null,
      seat: o.seat ? `${o.seatRole}/${o.seat}` : null, parent: o.parentSession ?? null,
      owner: o.ownership && o.ownership !== 'unknown' ? 'owner recorded' : 'no owner recorded' };
  });
}

const cap = (rows, limit, render) => rows.slice(0, limit).map(render)
  .concat(rows.length > limit ? [`  ... and ${rows.length - limit} more of the same`] : []);

// Fifty-five identical findings are one finding. Capping alone did not fix this -- eight copies of the
// same sentence still buried the two lines that mattered -- so repeats of a kind collapse into a single
// line carrying the count and who it applies to. The detail is printed once, because it is the same detail.
const collapse = rows => {
  const byKind = new Map();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  return [...byKind].map(([kind, rs]) => rs.length === 1
    ? `    ${kind.padEnd(20)} ${rs[0].who}\n      ${rs[0].detail}\n      -> ${rs[0].remedy}`
    : `    ${`${kind} x${rs.length}`.padEnd(20)} ${rs.slice(0, 3).map(r => r.who).join(', ')}${rs.length > 3 ? `, +${rs.length - 3} more` : ''}\n      ${rs[0].detail}\n      -> ${rs[0].remedy}`);
};

export function render(state) {
  const found = problems(state), inv = inventory(state);
  const bySeverity = SEVERITY.map(s => [s, found.filter(f => f.severity === s)]).filter(([, r]) => r.length);
  const grouped = new Map();
  for (const i of inv) grouped.set(i.project, [...(grouped.get(i.project) ?? []), i]);
  return [
    `CONTROL SITUATION  ${new Date().toISOString()}`,
    `${inv.length} session(s), ${found.length} thing(s) needing attention.`,
    '',
    found.length ? 'WHAT IS WRONG -- worst first' : 'NOTHING IS BLOCKED OR STUCK.',
    ...bySeverity.flatMap(([severity, rows]) => [`  ${severity}`, ...cap(collapse(rows), 8, l => l)]),
    '',
    'WHO OWNS WHAT',
    ...[...grouped].flatMap(([project, rows]) => [project ? `  project ${short(project)}` : '  (no project recorded)',
      ...cap(rows, 10, i => `    ${short(i.session)}  seat=${i.seat ?? '-'}  parent=${short(i.parent)}  mode=${i.mode ?? '-'}  ${i.owner}`)]),
    grouped.size ? null : '  (no sessions)',
    '',
    'WHAT THIS CANNOT SEE',
    '  - Whether a session is doing anything. The journal records deliveries, not work in progress:',
    '    a session with nothing outstanding may be busy thinking or may be idle, and this cannot tell them apart.',
    '  - Why a session has no recorded owner. Mode (human or delegated) is recorded and shown; ownership is',
    '    a separate fact, and this cannot say whether an unowned session was created outside the control',
    '    plane or lost its record. It reports the absence, not the cause.',
    '  - Anything outside the controller journal: the provider, the daemon, and the app have their own state.',
    '  - Only the tasks it was given. Deliveries are read per task, so a task not listed here is not covered.',
  ].filter(l => l !== null).join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = controlHome(), ask = reader({ home, reads: READS }), operator = operatorSecret(home);
  const [sessions, seats, allowances, requests, channels] = await Promise.all(
    ['list', 'bindings-status', 'roles-allowances', 'roles-session-requests', 'channels-status'].map(m => ask(m, operator)));
  const live = Array.isArray(sessions) ? sessions : [];
  const ownership = Object.fromEntries(await Promise.all(live.map(async s => [s.id, await ask('roles-ownership', operator, s.id)])));
  const deliveries = (await Promise.all([...new Set(live.map(s => s.task).filter(Boolean))]
    .map(t => ask('history', operator, t)))).flatMap(h => (Array.isArray(h) ? h : []));
  console.log(render({ sessions: live, seats, allowances, requests, channels, ownership, deliveries }));
  console.log('Read-only. Nothing above created, sent or changed anything.\n');
}

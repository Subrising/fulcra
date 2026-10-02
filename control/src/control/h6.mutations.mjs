// H6-CONTROL-REPORT.md mutation run (BRIEF-H6-CONTROL items 1-4). Not a test file (no .test. in the name).
//
//   node src/control/h6.mutations.mjs [ID...]
//
// Same contract as g-fixes.mutations.mjs: apply exact-anchor edits, run the named suite, require the named test to
// FAIL, restore the original bytes in a finally. An anchor that is not exactly once aborts the run. No mutation here
// runs provider-mode.test.mjs, so none can load an installed admission guard.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  at = (f) => path.join(here, f);
const RS = at("role-sessions.mjs"),
  CT = at("controller.mjs"),
  BD = at("bindings.mjs"),
  MX = at("metrics.mjs"),
  SV = at("server.mjs"),
  GF = at("guard-free-import.mjs"),
  PM = at("provider-mode.test.mjs");
const TS = at("tool-surface.mjs"),
  TR = at("tool-refresh.mjs"),
  HN = at("host-native.mjs"),
  TT = at("tool-surface.test.mjs");
const UL = at("usage-limits.mjs"),
  UT = at("usage-limits.test.mjs"),
  HNF = at("held-notifier.mjs"),
  RP = at("rpc.mjs");
const SD = at("seating-defaults.test.mjs"),
  SI = at("seat-inbox.test.mjs"),
  MG = at("manager.test.mjs"),
  MT = at("metrics.test.mjs"),
  GT = at("guard-free-import.test.mjs");
const M = [
  // item 1: RECHECK-H5 R-1 / R-2
  {
    id: "H1a",
    why: "R-1: a seat create writes into the reserve again",
    suite: SD,
    expect: "R-1: a seat’s own session create",
    edits: [[RS, "      this.assertCreateBudget(spec);\n      const fresh", "      const fresh"]],
  },
  {
    id: "H1b",
    why: "R-1: the brief’s row is not budgeted before creating",
    suite: SD,
    expect: "R-1: a seat’s own session create",
    edits: [[RS, "needed = spec.brief !== undefined ? 2 : 1", "needed = 1"]],
  },
  // Since REVIEW-H6 F1 the accept path is defended twice (the pre-check and the insertion guard), so the mutation removes both.
  {
    id: "H1c",
    why: "R-1: accepting an operator request is not budgeted, at either check (X: accept path)",
    suite: SD,
    expect: "R-1: a seat accepting an operator request",
    edits: [
      [
        RS,
        "      this.assertCreateBudget(spec);\n      const fresh",
        "      if (!requestId) this.assertCreateBudget(spec);\n      const fresh",
      ],
      [RS, "}, undefined, { automated: true }); }", "}, undefined, { automated: !requestId }); }"],
    ],
  },
  {
    id: "H1d",
    why: "R-2 (X13): role briefs are not automated",
    suite: SD,
    expect: "R-2: every automated send kind",
    edits: [[CT, "new Set(['role-brief', 'role-followup',", "new Set(['role-followup',"]],
  },
  {
    id: "H1e",
    why: "R-2 (X12): channel messages are not automated",
    suite: SD,
    expect: "R-2: every automated send kind",
    edits: [[CT, "'role-followup', 'role-channel', 'manager',", "'role-followup', 'manager',"]],
  },
  {
    id: "H1f",
    why: "R-2 (X11): request wakes lose their automated flag",
    suite: SD,
    expect: "R-2: every automated send kind",
    edits: [[RS, "{ automated: 'role-request-wake' }", "{}"]],
  },
  {
    id: "H1g",
    why: "R-2: manager assignments are not automated",
    suite: MG,
    expect: "R-2: a manager assignment is refused",
    edits: [[CT, "'role-channel', 'manager', 'event',", "'role-channel', 'event',"]],
  },
  {
    id: "H1h",
    why: "R-2: a model-driven call site with no kind (static pin)",
    suite: SD,
    expect: "R-2: every control.send call site",
    edits: [[RS, "{ automated: 'role-request-wake' }", "{ note: 'unclassified' }"]],
  },
  // item 2: reaffirmation carries grants forward
  {
    id: "H2a",
    why: "a reaffirmation carries nothing (the live gap)",
    suite: SD,
    expect: "H6-2: a reaffirmation carries the session allowance",
    edits: [[BD, "action === 'reaffirm' ? this.carryForward(", "false ? this.carryForward("]],
  },
  {
    id: "H2b",
    why: "the project side of an open channel is not carried",
    suite: SD,
    expect: "H6-2: a reaffirmation of either seat keeps an open channel",
    edits: [
      [
        BD,
        "SET projectRevision=? WHERE state='open' AND projectSeat=?",
        "SET projectRevision=? WHERE state='never' AND projectSeat=?",
      ],
    ],
  },
  {
    id: "H2c",
    why: "the prime side of an open channel is not carried",
    suite: SD,
    expect: "H6-2: a reaffirmation of either seat keeps an open channel",
    edits: [
      [
        BD,
        "SET primeRevision=? WHERE state='open' AND primeSeat=?",
        "SET primeRevision=? WHERE state='never' AND primeSeat=?",
      ],
    ],
  },
  {
    id: "H2d",
    why: "closed channels are carried too",
    suite: SD,
    expect: "H6-2: a reaffirmation of either seat keeps an open channel",
    edits: [
      [
        BD,
        "SET projectRevision=? WHERE state='open' AND projectSeat=?",
        "SET projectRevision=? WHERE projectSeat=?",
      ],
    ],
  },
  {
    id: "H2e",
    why: "the default-allowance marker is left behind (a default reads as an operator decision)",
    suite: SD,
    expect: "H6-2: a reaffirmation carries the session allowance",
    edits: [
      [
        BD,
        "run('role_default_allowances', 'UPDATE role_default_allowances SET seatRevision=?",
        "run('role_default_allowances', 'SELECT ?",
      ],
    ],
  },
  {
    id: "H2f",
    why: "a pending role credential is not carried",
    suite: SD,
    expect: "H6-2: pending work survives",
    edits: [
      [
        BD,
        "'UPDATE role_grant_pending SET revision=? WHERE",
        "'UPDATE role_grant_pending SET revision=revision WHERE revision=? AND",
      ],
    ],
  },
  {
    id: "H2g",
    why: "a deferred brief is not carried",
    suite: SD,
    expect: "H6-2: pending work survives",
    edits: [
      [
        BD,
        "UPDATE role_session_briefs SET seatRevision=? WHERE",
        "UPDATE role_session_briefs SET seatRevision=seatRevision WHERE seatRevision=? AND",
      ],
    ],
  },
  {
    id: "H2h",
    why: "an open session request is not carried",
    suite: SD,
    expect: "H6-2: pending work survives",
    edits: [
      [
        BD,
        "UPDATE role_session_requests SET seatRevision=? WHERE",
        "UPDATE role_session_requests SET seatRevision=seatRevision WHERE seatRevision=? AND",
      ],
    ],
  },
  {
    id: "H2i",
    why: "a human hold is not carried",
    suite: SI,
    expect: "H6-2: reaffirming a held prime",
    edits: [
      [
        BD,
        "'UPDATE seat_human_holds SET revision=? WHERE",
        "'UPDATE seat_human_holds SET revision=revision WHERE revision=? AND",
      ],
    ],
  },
  {
    id: "H2j",
    why: "a reaffirmation with manager is refused again",
    suite: SD,
    expect: "H6-2: a reaffirmation with manager issues",
    edits: [
      [
        BD,
        "        else await this.seatManager(a, result);",
        "        else result.defaults.managerGrant = { issued: false, blocked: 'A reaffirmation confers nothing' };",
      ],
    ],
  },
  {
    id: "H2k",
    why: "a reaffirmation with manager re-issues over a live grant (orphaning its workers)",
    suite: SD,
    expect: "G-1: an operator manager-grant stays session-bound",
    edits: [
      [
        BD,
        "        if (live) result.defaults.managerGrant =",
        "        if (false) result.defaults.managerGrant =",
      ],
    ],
  },
  {
    id: "H2l",
    why: "a replacement carries the old holder’s grants",
    suite: SD,
    expect: "H6-2: a replacement is unchanged",
    edits: [
      [
        BD,
        "action === 'reaffirm' ? this.carryForward(",
        "action !== 'assign' ? this.carryForward(",
      ],
    ],
  },
  // item 3: instrumentation
  {
    id: "H3a",
    why: "SQLite time is not attributed",
    suite: MT,
    expect: "each RPC logs one timestamped line",
    edits: [
      [
        MX,
        "if (r) { r.sqliteMs += performance.now() - started; r.sqliteCalls++; }",
        "if (false) { r.sqliteMs += 0; }",
      ],
    ],
  },
  {
    id: "H3b",
    why: "SQLite time is not scoped to its request",
    suite: MT,
    expect: "each RPC logs one timestamped line",
    edits: [
      [
        MX,
        "return await request.run(account, () => dispatch(req));",
        "return await request.run(shared, () => dispatch(req));",
      ],
      [
        MX,
        "const request = new AsyncLocalStorage();",
        "const request = new AsyncLocalStorage(), shared = { sqliteMs: 0, sqliteCalls: 0 };",
      ],
    ],
  },
  {
    id: "H3c",
    why: "error text reaches the log",
    suite: MT,
    expect: "a line never carries input",
    edits: [
      [MX, "errorClass = e?.constructor?.name ?? 'Error';", "errorClass = String(e?.message);"],
    ],
  },
  {
    id: "H3d",
    why: "the method name is not sanitised",
    suite: MT,
    expect: "a line never carries input",
    edits: [
      [
        MX,
        "known instanceof Set && known.has(r.method)) ? r.method : 'unknown'",
        "true) ? r.method : 'unknown'",
      ],
    ],
  },
  {
    id: "H3e",
    why: "the log never rotates (unbounded)",
    suite: MT,
    expect: "the log rotates at its bound",
    edits: [
      [MX, "      if (this.size + Buffer.byteLength(text) > this.maxBytes) this.rotate();\n", ""],
    ],
  },
  {
    id: "H3f",
    why: "an unverified file is written anyway",
    suite: MT,
    expect: "an unverifiable stdout",
    edits: [[MX, "out.dev === at.dev && out.ino === at.ino", "true"]],
  },
  {
    id: "H3g",
    why: "the loop window never resets",
    suite: MT,
    expect: "the event-loop sampler",
    edits: [[MX, "counter.rpcs = 0; h.reset();", ""]],
  },
  {
    id: "H3h",
    why: "server.mjs does not instrument the store",
    suite: MT,
    expect: "server.mjs is wired",
    edits: [
      [
        SV,
        "store = instrumentDb(new ControlStore(`${HOME}/journal.sqlite`))",
        "store = (new ControlStore(`${HOME}/journal.sqlite`))",
      ],
    ],
  },
  // item 4: no live receipts from the suite
  {
    id: "H4a",
    why: "provider-mode imports exports.js again",
    suite: GT,
    expect: "every installed-server module a test imports",
    edits: [
      [
        PM,
        "(await guardFreeImport(createRequire(path.join(ADAPTER, 'package.json')).resolve('@getpaseo/protocol/provider-manifest'))).AGENT_PROVIDER_DEFINITIONS",
        "(await import(pathToFileURL(path.join(DIST, 'exports.js')).href)).AGENT_PROVIDER_DEFINITIONS",
      ],
    ],
  },
  {
    id: "H4b",
    why: "guardReach does not follow dynamic import()",
    suite: GT,
    expect: "a module that can reach an admission guard",
    edits: [
      [
        GF,
        String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)`,
        String.raw`(?:\bfrom\s*|\bimport\s+)`,
      ],
    ],
  },
  {
    id: "H4c",
    why: "guardReach does not recognise a guard",
    suite: GT,
    expect: "a module that can reach an admission guard",
    edits: [[GF, "if (/admission-guard(\\.mjs)?$/.test(spec))", "if (false)"]],
  },
  // item 5: tool surface refresh (G5)
  {
    id: "H5a",
    why: "the surface loses the role tools",
    suite: TT,
    expect: "the creation surface is exactly the pre-H6 one",
    edits: [[TS, "    ...ROLE_TOOLS.map(t => mcp(SUPERVISOR_SERVER, t)),", "   "]],
  },
  {
    id: "H5b",
    why: "a refresh preapproves memory tools for a session without that server",
    suite: TT,
    expect: "refreshToolsFor sends one fenced refresh",
    edits: [
      [TS, "toolPolicy({ memory: state.mcpServerNames.includes(MEMORY_SERVER) })", "toolPolicy()"],
    ],
  },
  {
    id: "H5c",
    why: "a refused daemon refresh is reported as success",
    suite: TT,
    expect: "refreshToolsFor refuses clearly",
    edits: [
      [
        TS,
        "if (result.outcome !== 'refreshed' && result.outcome !== 'unchanged') throw",
        "if (false) throw",
      ],
    ],
  },
  {
    id: "H5d",
    why: "an SDK without the refresh API is not named",
    suite: TT,
    expect: "refreshToolsFor refuses clearly",
    edits: [
      [
        TS,
        "if (typeof agent?.getMcpRefreshState !== 'function' || typeof agent?.refreshMcp !== 'function')\n",
        "if (false)\n",
      ],
    ],
  },
  {
    id: "H5e",
    why: "a human-held session is refreshed",
    suite: TT,
    expect: "the operator route refuses a human-held session",
    edits: [
      [
        TR,
        "if (s.mode !== 'delegated') throw Error('A tool refresh needs",
        "if (false) throw Error('A tool refresh needs",
      ],
    ],
  },
  {
    id: "H5f",
    why: "a failed refresh claims the surface",
    suite: TT,
    expect: "the operator route refuses a human-held session",
    edits: [
      [
        TR,
        "this.record(id, s.generation, 'failed', `${cause}: ${e.message}`, null);",
        "this.record(id, s.generation, 'failed', `${cause}: ${e.message}`, TOOL_SURFACE);",
      ],
    ],
  },
  {
    id: "H5g",
    why: "a handback does not refresh a seat",
    suite: TT,
    expect: "a handback of a seat holder brings its tools up to date",
    edits: [[CT, "    try { this.tools?.afterDelegation(id); }", "    try { void 0; }"]],
  },
  {
    id: "H5h",
    why: "every delegated session is refreshed, not only seats and managers",
    suite: TT,
    expect: "a handback of a seat holder brings its tools up to date",
    edits: [[TR, "    return Boolean(seat || manager);", "    return true;"]],
  },
  {
    id: "H5i",
    why: "a failing automatic refresh fails the handback",
    suite: TT,
    expect: "a failing automatic refresh never fails the handback",
    edits: [
      [
        TR,
        "    catch (e) { this.lastError = { message: e.message, at: new Date().toISOString() }; return {",
        "    catch (e) { throw e; return {",
      ],
    ],
  },
  {
    id: "H5j",
    why: "a reaffirmation does not refresh",
    suite: TT,
    expect: "a reaffirmation of a delegated seat refreshes its tools",
    edits: [
      [
        BD,
        "if (outcome.result.action === 'reaffirm' && this.control.tools)",
        "if (false && this.control.tools)",
      ],
    ],
  },
  {
    id: "H5k",
    why: "the status does not ask for a refresh",
    suite: TT,
    expect: "an operator refreshes a pre-H6 seat",
    edits: [
      [
        BD,
        "      if (surface && surface.state !== 'current') needs.push('tool-surface-refresh');\n",
        "",
      ],
    ],
  },
  {
    id: "H5l",
    why: "a new session does not record its surface",
    suite: TT,
    expect: "a session created by this release records its surface",
    edits: [[CT, "...(agent.toolSurface ? { toolSurface: agent.toolSurface } : {}),", ""]],
  },
  {
    id: "H5m",
    why: "a Book session’s refresh takes the local path",
    suite: TT,
    expect: "only a local session",
    edits: [
      [
        HN,
        "if(this.route(id))throw Error('Tool surfaces of a remote (Book) session are refreshed on its own host'); ",
        "",
      ],
    ],
  },
  {
    id: "H5n",
    why: "the controller SDK is pinned back to a bundle without the refresh API",
    suite: TT,
    expect: "refreshToolsFor refuses clearly",
    edits: [
      [
        at("client-sdk.mjs"),
        "'/Volumes/test-volume/openclaw/projects/orca-controller-sdk-20260925/d5f1094e91aee513/client.mjs'",
        "'/Volumes/test-volume/openclaw/projects/orca-quota-sdk-20260917/f7f1cbd34e6f5031/client.mjs'",
      ],
      [
        at("client-sdk.mjs"),
        "'d5f1094e91aee51300c362540c783faaaa9c61cfc21b14f3e80aff15dbc89ccf'",
        "'f7f1cbd34e6f503165181bbc1b25c943fd2a0fe8230cd9f862daaa4c39f28483'",
      ],
    ],
  },
  // item 6: Claude usage-limit auto-resume
  {
    id: "H6a",
    why: "the limit line matches inside other text",
    suite: UT,
    expect: "only the WHOLE line parses",
    edits: [[UL, "const LINE = /^You(?:'|\u2019)ve", "const LINE = /You(?:'|\u2019)ve"]],
  },
  {
    id: "H6b",
    why: "a stop is detected under a newer entry",
    suite: UT,
    expect: "a stop is the newest entry",
    edits: [[UL, "(tail.maxSeq !== undefined && last.seqEnd !== tail.maxSeq)", "false"]],
  },
  {
    id: "H6c",
    why: "user text is read as a limit",
    suite: UT,
    expect: "a stop is the newest entry",
    edits: [[UL, "  if (last.item?.type !== 'assistant_message') return null;\n", ""]],
  },
  {
    id: "H6d",
    why: "the reset is resolved against the time of observation",
    suite: UT,
    expect: "a stop is the newest entry",
    edits: [
      [
        UL,
        "const stoppedAt = Date.parse(last.timestamp ?? tail.updatedAt ?? '');",
        "const stoppedAt = Date.now();",
      ],
    ],
  },
  {
    id: "H6e",
    why: "a human-held session is sent a continuation",
    suite: UT,
    expect: "a human-held session is never sent anything",
    edits: [[UL, "    if (s.mode !== 'delegated') return this.notify(r, s);\n", ""]],
  },
  {
    id: "H6f",
    why: "a session that moved on is resumed anyway",
    suite: UT,
    expect: "a session that moved on",
    edits: [
      [
        UL,
        "if (!stop || stop.seq !== r.seq || stop.messageId !== r.messageId || (tail.lastUserMessageAt ?? null) !== (r.lastUserMessageAt ?? null))",
        "if (false)",
      ],
    ],
  },
  {
    id: "H6g",
    why: "no daily cap",
    suite: UT,
    expect: "resumes are capped per session per day",
    edits: [[UL, "if (recent >= MAX_RESUMES_PER_DAY) {", "if (false) {"]],
  },
  {
    id: "H6h",
    why: "the continuation is not automated traffic",
    suite: UT,
    expect: "the continuation is automated traffic",
    edits: [[UL, "{ automated: 'usage-limit-resume', check:", "{ check:"]],
  },
  {
    id: "H6i",
    why: "the continuation id is not derived from the stop",
    suite: UT,
    expect: "a delegated session that stopped at the limit is resumed once",
    edits: [
      [
        UL,
        "const continuation = derived(r.id, 'usage-limit-continue');",
        "const continuation = derived(r.id + this.now() + Math.random(), 'usage-limit-continue');",
      ],
    ],
  },
  {
    id: "H6j",
    why: "busy retries are unbounded",
    suite: UT,
    expect: "a busy session is retried with backoff",
    edits: [
      [
        UL,
        "if (e instanceof RecipientBusy && attempts < MAX_ATTEMPTS) {",
        "if (e instanceof RecipientBusy) {",
      ],
    ],
  },
  {
    id: "H6k",
    why: "the resume is scheduled before the reset",
    suite: UT,
    expect: "a delegated session that stopped at the limit is resumed once",
    edits: [[UL, "Date.parse(row.resetAt) + this.jitter()", "Date.parse(row.resetAt) - 3600000"]],
  },
  {
    id: "H6l",
    why: "every daemon update costs a timeline read",
    suite: UT,
    expect: "an unresolvable reset is recorded",
    edits: [[UL, "    if (this.seen.get(a.id) === a.updatedAt) return null;\n", ""]],
  },
  {
    id: "H6m",
    why: "the watchdog never resumes",
    suite: UT,
    expect: "server.mjs is wired",
    edits: [[SV, " void control.usageLimits.tick();", ""]],
  },
  {
    id: "H6n",
    why: "recovery-status does not show the stops",
    suite: UT,
    expect: "a delegated session that stopped at the limit is resumed once",
    edits: [[RP, "usageLimits: control.usageLimits?.status() ?? null, ", ""]],
  }, // H7: the line also carries wakes and providerRecovery
  {
    id: "H6o",
    why: "the notice accepts arbitrary text",
    suite: UT,
    expect: "a Book (remote) session is not read here",
    edits: [
      [
        HNF,
        "  if (!UUID.test(n.session) || !RESET.test(n.reset)) throw Error('A usage-limit notice names only a session id and its reset time');\n",
        "",
      ],
    ],
  },
  {
    id: "H6p",
    why: "the resume call site loses its automated kind (static R-2 pin)",
    suite: SD,
    expect: "R-2: every control.send call site",
    edits: [[UL, "{ automated: 'usage-limit-resume', check:", "{ check:"]],
  },
  // REVIEW-H6 (Codex reviewer) findings, fixed
  {
    id: "RF1a",
    why: "F1: automated sends are not guarded at insertion (AT5)",
    suite: SD,
    expect: "REVIEW-H6 F1 (AT5)",
    edits: [
      [
        CT,
        "() => { if (automated && !this.store.delivery(a.messageId)) this.automationGuard(); this.allowance.charge(row.task, a.messageId); }",
        "() => this.allowance.charge(row.task, a.messageId)",
      ],
    ],
  },
  {
    id: "RF1f",
    why: "F1: the insertion guard refuses a row reserved earlier inside the limit (a leadership wake)",
    suite: at("leadership.test.mjs"),
    expect: "capacity is reserved before authority commits",
    edits: [
      [
        CT,
        "if (automated && !this.store.delivery(a.messageId)) this.automationGuard(); this.allowance.charge",
        "if (automated) this.automationGuard(); this.allowance.charge",
      ],
    ],
  },
  {
    id: "RF1b",
    why: "F1: automated creates are not guarded at insertion (AT1)",
    suite: SD,
    expect: "REVIEW-H6 F1 (AT1)",
    edits: [[CT, "automated ? () => this.automationGuard() : undefined", "undefined"]],
  },
  {
    id: "RF1c",
    why: "F1: a seat create is not marked automated",
    suite: SD,
    expect: "REVIEW-H6 F1 (AT1)",
    edits: [[RS, "}, undefined, { automated: true }); }", "}); }"]],
  },
  {
    id: "RF1d",
    why: "F1: a create refused at insertion keeps its spent reservation",
    suite: SD,
    expect: "REVIEW-H6 F1 (AT1)",
    edits: [
      [
        RS,
        "if (reservation.reserved && !this.store.delivery(spec.messageId)) this.releaseReservation(spec); throw e;",
        "throw e;",
      ],
    ],
  },
  {
    id: "RF1e",
    why: "F1: a send parked on quota is not guarded in park()",
    suite: at("quota-runtime.test.mjs"),
    expect: "REVIEW-H6 F1: a manager assignment that parks",
    edits: [
      [
        CT,
        "if (automated && !this.store.delivery(a.messageId)) this.automationGuard(); return r;",
        "return r;",
      ],
    ],
  },
  {
    id: "RF2a",
    why: "F2: the method is logged by pattern again",
    suite: MT,
    expect: "a line never carries input",
    edits: [
      [
        MX,
        "known instanceof Set && known.has(r.method)) ? r.method",
        "/^[a-z][a-z0-9-]{0,63}$/.test(r.method)) ? r.method",
      ],
    ],
  },
  {
    id: "RF2b",
    why: "F2: server.mjs does not pass the closed set",
    suite: MT,
    expect: "server.mjs is wired",
    edits: [[SV, "log, counter, RPC_METHODS);", "log, counter);"]],
  },
  {
    id: "RF2c",
    why: "F2: RPC_METHODS drifts from the dispatcher",
    suite: at("rpc-methods.test.mjs"),
    expect: "RPC_METHODS equals every method literal",
    edits: [[RP, "'sessions-tool-surface', ", ""]],
  },
  {
    id: "RF3",
    why: "F3: a current surface is not evidence of the role environment",
    suite: TT,
    expect: "REVIEW-H6 F3 (AT6)",
    edits: [
      [
        BD,
        "const born = bornWith === true || surface?.state === 'current' ? true : bornWith;",
        "const born = bornWith;",
      ],
    ],
  },
];
export { M };

function failing(suite) {
  let out;
  try {
    out = execFileSync(process.execPath, ["--test", "--test-reporter=tap", suite], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stdout ?? "");
  }
  return [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1]);
}
const only = process.argv.slice(2);
let bad = 0;
for (const m of M.filter((x) => !only.length || only.includes(x.id))) {
  const originals = new Map();
  try {
    for (const [file, from, to] of m.edits) {
      const text = originals.get(file) ?? fs.readFileSync(file, "utf8");
      originals.set(file, text);
      const current = fs.readFileSync(file, "utf8");
      if (current.split(from).length !== 2)
        throw Error(`${m.id}: anchor does not occur exactly once in ${path.basename(file)}`);
      fs.writeFileSync(
        file,
        current.replace(from, () => to),
      );
    }
    const failed = failing(m.suite),
      killed = failed.some((name) => name.includes(m.expect));
    if (!killed) bad++;
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"} ${m.id.padEnd(5)} ${m.why} -> expected red: "${m.expect}"; red: ${failed.length ? failed.map((n) => n.slice(0, 40)).join(" | ") : "none"}`,
    );
  } finally {
    for (const [file, text] of originals) fs.writeFileSync(file, text);
  }
}
console.log(bad ? `${bad} mutation(s) SURVIVED` : "all mutations killed");
process.exitCode = bad ? 1 : 0;

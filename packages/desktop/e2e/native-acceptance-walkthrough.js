#!/usr/bin/env node
/**
 * Smoke test of the INSTALLED app across every surface (J5), grown from the GOAL item 6 walkthrough.
 *
 *   FULCRA_EVIDENCE_DIR=... FULCRA_SCRATCH_DIR=... node packages/desktop/e2e/native-acceptance-walkthrough.js
 *   node packages/desktop/e2e/native-acceptance-walkthrough.js --self-test   # no app, no host
 *   ... native-acceptance-walkthrough.js --pillars   # J0: each Command Centre tab, 1280x800 + 390x844, dark + light
 *
 * Why this exists: the Mini's screen is locked, so nobody can click. Playwright drives the packaged
 * Electron build over CDP, which renders regardless of whether a human can see the screen.
 *
 * One step per surface. Each step writes a screenshot and a visible-label transcript (the text and
 * accessible names a user sees, tagged sidebar/surface), both scrubbed, and ends PASS, FAIL,
 * NOT PRESENT (the surface has not landed yet; the screenshot shows where it will be) or SKIPPED with
 * a reason. SUMMARY.md and summary.json list every step. The run exits 1 on any FAIL, on a secret
 * found in the evidence, or on visible branding when FULCRA_BRANDING_MODE=assert.
 *
 * PERSONAL-DATA GATE (J0). Every capture's visible-label transcript is checked with the Command Centre's
 * noPersonal patterns (smoke-personal-scan.js: personal paths, *.ts.net and *.local hosts, emails, tokens) and
 * this machine's own names, read at run time. Any hit fails the run, because such a screenshot is not
 * publishable. FULCRA_PERSONAL_GATE=report records hits without failing, for private diagnostic runs only.
 *
 * --pillars launches and connects as below, then captures each ready tab (FULCRA_PILLARS, default
 * organisation,sessions,trackers) at 1280x800 and 390x844 in dark and light into FULCRA_PILLAR_OUT (default
 * <evidence>/pillars). It presses only the sidebar item and those tabs' test ids, through pressTab(), which refuses
 * any other key and any control whose name reads like an action.
 *
 * READ-ONLY BY CONSTRUCTION. It adds a host to a scratch profile, opens surfaces and reads labels.
 * The only controls it presses are the welcome/connect form, the sidebar surface item, three of the
 * surface's tabs (never "Manage task"), "Project overview: <name>", "Sessions in this project",
 * "Show more work", "Read retained updates" and "Back to leadership" -- each of which only changes
 * what the client shows. It never sends a prompt, opens a conversation, creates a session, starts
 * work, takes over, hands back or grants.
 *
 * SAFETY, because this runs beside a live installation someone is using:
 *   - a scratch --user-data-dir, HOME and PASEO_HOME under FULCRA_SCRATCH_DIR, deleted after the run
 *     (the saved host entry holds the credential), so the real profile is untouched;
 *   - PASEO_DISABLE_SINGLE_INSTANCE_LOCK=1, without which Electron's lock hands the launch to the
 *     ALREADY RUNNING window instead of starting a second one -- it would drive David's app;
 *   - the password is read from a file at run time and never logged. Before every capture, password
 *     inputs are blanked and every literal secret and known token shape is replaced in the DOM; labels
 *     are redacted again before they are written; and smoke-secret-scan.js scans the whole evidence
 *     directory afterwards and fails the run on a hit.
 *
 * Environment:
 *   FULCRA_EVIDENCE_DIR   required; screenshots, transcripts and SUMMARY.md (created mode 700)
 *   FULCRA_SCRATCH_DIR    required; parent of this run's scratch profile
 *   FULCRA_APP_PATH       default /Applications/Fulcra.app
 *   FULCRA_HOST/PORT      default 127.0.0.1 / 6791
 *   FULCRA_PASSWORD_FILE  path to the daemon's controller.secret
 *   FULCRA_EXTRA_SECRET_FILES  colon-separated; more literal secrets to scrub and scan for
 *   FULCRA_BRANDING_MODE  off | report (default) | assert -- J1's visible "Orca"/"Paseo" check
 *   FULCRA_LOCAL_HOST_LABEL  host label of this Mac's rows in Live work (default Mini)
 *   FULCRA_DAEMON_PID_FILE / FULCRA_CONTROLLER_PID_FILE  read for restart times (recovery step)
 *   FULCRA_PILLARS / FULCRA_PILLAR_OUT  --pillars: which tabs, and where the captures go
 *   FULCRA_PERSONAL_GATE  assert (default) | report
 *   FULCRA_PERSONAL_NAMES  comma-separated extra names the gate refuses, besides this machine's own
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { localMachine } = require("../../../control/src/local-machine.mjs");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const secretScan = require("./smoke-secret-scan");
const personalScan = require("./smoke-personal-scan");

const APP_PATH = process.env.FULCRA_APP_PATH ?? "/Applications/Fulcra.app";
const HOST = process.env.FULCRA_HOST ?? "127.0.0.1";
const PORT = process.env.FULCRA_PORT ?? "6791";
const PASSWORD_FILE = process.env.FULCRA_PASSWORD_FILE ?? localMachine("acceptancePasswordFile");
const EXTRA_SECRET_FILES = (process.env.FULCRA_EXTRA_SECRET_FILES ?? "").split(":").filter(Boolean);
const EVIDENCE_DIR = process.env.FULCRA_EVIDENCE_DIR;
const SCRATCH_DIR = process.env.FULCRA_SCRATCH_DIR;
const STEP_TIMEOUT_MS = Number(process.env.FULCRA_STEP_TIMEOUT_MS ?? 45_000);
const BRANDING_MODE = process.env.FULCRA_BRANDING_MODE ?? "report";

// What the app is expected to show. Sourced from the installed plugin and the app, not invented:
// the sidebar title is the plugin's SIDEBAR_TITLE (client/build-identity.ts), the tabs are organization.tsx's.
// J6: controls are located by TEST ID, never by visible text -- J5 found the text locator stale ("Orca (staged
// next)" after the rename) and, in a supplementary script, a free-text locator matched a sidebar SESSION title.
// The title is still read, but only as an assertion about what the user sees.
const SIDEBAR_ITEM = process.env.FULCRA_SIDEBAR_ITEM ?? "Fulcra";
// The app renders a plugin sidebar item as testID `plugin-sidebar-<pluginId>-<contributionId>`
// (packages/app/src/plugins/sidebar-items.tsx); the plugin id is the installed one, the item id is "organization".
const PLUGIN_ID = process.env.FULCRA_PLUGIN_ID ?? "orca-organization-next";
const SIDEBAR_TEST_ID = `plugin-sidebar-${PLUGIN_ID}-organization`;
const PROJECT_NAME = process.env.FULCRA_PROJECT_NAME ?? "Orca platform";
// Printed by the surface itself, so interactions can be scoped to it rather than to the whole window.
const SURFACE_MARKER = process.env.FULCRA_SURFACE_MARKER ?? "FULCRA / PRIME LEADERSHIP";
// Test ids from the plugin's organization.tsx (J6, control repo 93398d84): organization-tab-<key>.
const TABS = { leadership: "leadership", workstreams: "portfolio", liveWork: "fleet" };
// J0 regroup (control repo cc/j0-foundation): Work map, Leadership, Workstreams and Manage task live inside the
// Organisation tab, which must be selected before their test ids exist. A plugin without it predates J0.
const ORGANISATION_VIEWS = new Set(["workmap", "leadership", "portfolio", "task"]);

// J0 per-pillar capture (--pillars): each ready Command Centre tab at both sizes, dark and light.
const PILLARS = (process.env.FULCRA_PILLARS ?? "organisation,sessions,trackers")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const PILLAR_SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];
const PILLAR_SCHEMES = ["dark", "light"];
// The personal-data gate fails the run on any hit. "report" only records it, for private diagnostic runs whose
// evidence is never published.
const PERSONAL_GATE = process.env.FULCRA_PERSONAL_GATE ?? "assert";
// Accessible names this harness must never press, whatever a locator resolves to (J7 deny-list).
const DENY_WORDS =
  /\b(create|send|archive|take over|hand back|grant|resume|dismiss|refresh|freeze|delete|remove|stop|restart|reset|interrupt|cancel|submit|import|worktree|pair|disconnect|approve|reject|assign|adopt|unlink|link)\b/i;

// Surfaces still in design. Each is NOT PRESENT until a SURFACE label matches its marker; when the
// workstream lands, set the marker to the heading it actually ships (or its env override) and the
// step starts asserting. Markers are whole-label heading shapes, never keywords: the first v1 run
// "found" ADW evidence in a session called "Practical ADW release completion" and ingress status in
// a project description mentioning Discord. Only surface labels count, because the welcome page and
// help menu carry the inherited Discord community link.
const PENDING_SURFACES = {
  j2: new RegExp(process.env.FULCRA_J2_MARKER ?? "^work view$", "i"),
  j3: new RegExp(process.env.FULCRA_J3_MARKER ?? "^(issues|linked issues|issue trackers?)$", "i"),
  j4: new RegExp(process.env.FULCRA_J4_MARKER ?? "^(archify map|architecture map)$", "i"),
  adw: new RegExp(process.env.FULCRA_ADW_MARKER ?? "^ADW evidence$", "i"),
  ingress: new RegExp(
    process.env.FULCRA_INGRESS_MARKER ??
      "^(openclaw|discord)( ?[/&] ?(openclaw|discord))? (ingress|status)$",
    "i",
  ),
};

// Codex is not run before this date. The gate is on the machine's local calendar date.
const CODEX_NOT_BEFORE = "2026-09-24";

const RESULT = { PASS: "PASS", FAIL: "FAIL", NOT_PRESENT: "NOT PRESENT", SKIPPED: "SKIPPED" };

let literalSecrets = [];
const redact = (text) => secretScan.redactText(text, literalSecrets);

function log(message) {
  console.log(`[smoke] ${redact(message)}`);
}

function localDate(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whether Codex steps may run on `now`'s local date. */
function codexGate(now = new Date()) {
  const today = localDate(now);
  if (today >= CODEX_NOT_BEFORE) return { open: true, today };
  return {
    open: false,
    today,
    reason: `Codex steps are gated until ${CODEX_NOT_BEFORE} (local date today: ${today}); not run`,
  };
}

// ---------------------------------------------------------------------------------------------
// J1 branding. Identifiers J1 keeps (bundle id, data dirs, CLI/package/protocol/plugin names) are
// removed before looking; what is left that still says Orca or Paseo is either a name a person gave
// to their own work ("Orca platform") or app text J1 has to replace ("Loading Orca").

const KEPT_IDENTIFIERS = [
  /\bdev\.orca\.[\w.-]+/gi,
  /\borca-organization(?:-next)?\b/gi,
  /@getpaseo\/[\w-]+/gi,
  /\bPASEO_[A-Z0-9_]+\b/g,
  /(?:~|\$HOME)?\/\.paseo\b/gi,
  /\bpaseo(?:-plugin)?\.json\b/gi,
  /\borca-[\w-]+-\d{8}\b/gi,
];

const HAS_BRAND_WORD = /\b(orca|paseo)\b/i;

// Accessible names that carry a user-given name after a fixed prefix. The name is user data; the
// prefix is app text.
const USER_NAME_SHAPES = [
  /^Open session: (.+)$/,
  /^Open the session this request produced: (.+)$/,
  /^Project overview: (.+)$/,
  /^Open project (?:with an orchestrator|needing an orchestrator): (.+)$/,
  /^Talk to (.+?), (?:project orchestrator|prime seat .+)(?: ↗)?$/,
  /^Read retained updates from (.+?)(?:, .+)?$/,
  /^Inspect (.+)$/,
  /^(.+?) · (?:led|needs an orchestrator)$/,
  /^(?:Workstream for new work|Progress and decisions|Manage leaders|Accountable for|Manage workstream|Saved team): (.+)$/,
  /^(?:Lead orchestrator|RESPONSIBLE FOR) · (.+)$/,
];

function harvestUserNames(entries) {
  const names = new Set();
  for (const { text } of entries)
    for (const shape of USER_NAME_SHAPES) {
      const hit = shape.exec(text);
      if (hit?.[1]) names.add(hit[1].trim());
    }
  return names;
}

function brandingHits(entries, userNames) {
  const hits = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.region}|${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let withoutKept = entry.text;
    for (const kept of KEPT_IDENTIFIERS) withoutKept = withoutKept.replace(kept, " ");
    // Only identifiers J1 keeps: not a hit at all.
    if (!HAS_BRAND_WORD.test(withoutKept)) continue;
    let rest = withoutKept;
    for (const name of userNames) if (name) rest = rest.split(name).join(" ");
    const kind = HAS_BRAND_WORD.test(rest) ? "app-text" : "user-named";
    hits.push({ text: entry.text, region: entry.region, step: entry.step, kind });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// App and capture.

function reserveLocalTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function launchApp() {
  const executable = path.join(APP_PATH, "Contents", "MacOS", path.basename(APP_PATH, ".app"));
  if (!fs.existsSync(executable)) throw new Error(`No packaged executable at ${executable}`);
  fs.mkdirSync(SCRATCH_DIR, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(SCRATCH_DIR, "run-"));
  const userData = path.join(scratch, "user-data");
  const paseoHome = path.join(scratch, "paseo-home");
  fs.mkdirSync(userData);
  fs.mkdirSync(paseoHome);
  const cdpPort = await reserveLocalTcpPort();

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    HOME: scratch,
    PASEO_HOME: paseoHome,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    // Without this Electron's single-instance lock forwards the launch to the window already open on
    // this machine, and the script would drive somebody's live session instead of its own.
    PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  };

  log(`launching a separate instance with a scratch profile (cdp ${cdpPort})`);
  const child = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return { child, cdpPort, scratch };
}

async function connectRenderer(cdpPort) {
  const { chromium } = require("playwright");
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const context = browser.contexts()[0];
      const page =
        context.pages().find((candidate) => !candidate.url().startsWith("devtools://")) ??
        (await context.waitForEvent("page"));
      await page.waitForLoadState("domcontentloaded");
      return { browser, page };
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`renderer did not expose CDP in time: ${lastError?.message ?? "unknown"}`);
}

/**
 * Blank every password field and replace every literal secret and known token shape in the DOM's
 * text and attributes. Runs before every screenshot, so the pixels never show a secret either.
 */
async function scrubBeforeCapture(page) {
  const shapes = secretScan.SECRET_PATTERNS.map(({ re }) => [re.source, re.flags]);
  await page.evaluate(
    ({ literals, sources, redacted }) => {
      const res = sources.map(([source, flags]) => new RegExp(source, flags));
      const clean = (value) => {
        let out = value;
        for (const literal of literals) out = out.split(literal).join(redacted);
        for (const re of res) out = out.replace(re, redacted);
        return out;
      };
      for (const input of document.querySelectorAll("input, textarea")) {
        const isPassword =
          input.type === "password" ||
          literals.includes(input.value) ||
          input.getAttribute("data-testid") === "direct-password-input";
        if (isPassword) {
          input.value = "";
          input.setAttribute("value", "");
        } else if (input.value) input.value = clean(input.value);
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const next = clean(node.nodeValue ?? "");
        if (next !== node.nodeValue) node.nodeValue = next;
      }
      for (const el of document.querySelectorAll("[aria-label],[title]"))
        for (const attr of ["aria-label", "title"]) {
          const value = el.getAttribute(attr);
          if (value && clean(value) !== value) el.setAttribute(attr, clean(value));
        }
    },
    { literals: literalSecrets, sources: shapes, redacted: secretScan.REDACTED },
  );
}

/**
 * The visible-label transcript: leaf text and accessible names of rendered elements, each tagged
 * `surface` or `sidebar` by where it sits, and whether it is inside the viewport (the rest is
 * reachable by scrolling). The sidebar/surface boundary is the left edge of the surface's tab row.
 */
async function visibleLabels(page) {
  return page.evaluate((tabPrefix) => {
    // A hidden subtree is pruned; a zero-size box is not, because React Native Web wrappers can have
    // no box of their own (display: contents) while their children render normally.
    const hiddenSubtree = (el) => {
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
    };
    const hasBox = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    // Without the tab row there is no organization surface on screen, and nothing may count as
    // "surface": the welcome page's Discord community link would otherwise satisfy the ingress step.
    // J7: located by the tabs' test ids. 2dd360833 turned TABS into test-id keys but this still searched for the
    // visible label, so nothing ever counted as "surface" and every surface check read an empty list. The leftmost
    // tab is the boundary: Work map now comes before Leadership.
    let surfaceLeft = Infinity;
    for (const el of document.querySelectorAll(`[data-testid^="${tabPrefix}"]`))
      if (hasBox(el)) surfaceLeft = Math.min(surfaceLeft, el.getBoundingClientRect().left);
    const seen = new Map();
    const add = (text, el) => {
      const clean = text.replace(/\s+/g, " ").trim();
      if (!clean || !hasBox(el)) return;
      const rect = el.getBoundingClientRect();
      let region = "page";
      if (surfaceLeft !== Infinity) region = rect.left + 1 >= surfaceLeft ? "surface" : "sidebar";
      const inViewport =
        rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const key = `${region}|${clean}`;
      const prior = seen.get(key);
      if (!prior) seen.set(key, { text: clean, region, inViewport });
      else prior.inViewport ||= inViewport;
    };
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (hiddenSubtree(child)) continue;
        const own = child.getAttribute("aria-label");
        if (own) add(own, child);
        const text = child.textContent ?? "";
        if (child.children.length === 0) add(text, child);
        else walk(child);
      }
    };
    walk(document.body);
    return [...seen.values()].slice(0, 800);
  }, "organization-tab-");
}

// ---------------------------------------------------------------------------------------------
// Step machinery.

const run = {
  startedAt: new Date().toISOString(),
  app: APP_PATH,
  host: `${HOST}:${PORT}`,
  brandingMode: BRANDING_MODE,
  steps: [],
  allLabels: [],
  personalGate: PERSONAL_GATE,
  personal: [],
};
// This machine's names for the personal-data gate. Read at run time and deliberately NOT on `run`, which is
// written to summary.json: the names must never appear in the evidence they are checked against.
let personalNames = [];

/** Screenshot + transcript for the current state, attached to `record`. */
async function shot(page, record, suffix = "", dir = EVIDENCE_DIR) {
  const name = `${record.id}${suffix}`;
  await scrubBeforeCapture(page);
  const png = path.join(dir, `${name}.png`);
  await page.screenshot({ path: png, fullPage: false });
  const entries = await visibleLabels(page);
  for (const entry of entries) entry.text = redact(entry.text);
  const transcriptFile = path.join(dir, `${name}.labels.json`);
  fs.writeFileSync(
    transcriptFile,
    `${JSON.stringify({ step: record.id, title: record.title, capturedAt: new Date().toISOString(), labels: entries }, null, 2)}\n`,
    { mode: 0o600 },
  );
  record.screenshots.push(path.basename(png));
  record.transcripts.push(path.basename(transcriptFile));
  for (const entry of entries) run.allLabels.push({ ...entry, step: record.id });
  // J0 personal-data gate: kinds and label indexes only, never the matched text.
  const personal = personalScan.transcriptFindings(entries, personalNames);
  if (personal.length) {
    run.personal.push({
      capture: path.basename(png),
      findings: personal.map(({ kind, index, region }) => ({ kind, index, region })),
    });
    log(
      `${name}: PERSONAL DATA in ${personal.length} label(s): ${[...new Set(personal.map((f) => f.kind))].join(", ")}`,
    );
  }
  log(`${name}: ${entries.length} labels -> ${path.basename(png)}`);
  return entries;
}

const surfaceTexts = (entries) => entries.filter((e) => e.region === "surface").map((e) => e.text);

function requireLabel(texts, pattern, what) {
  const hit = texts.find((label) => pattern.test(label));
  if (!hit) {
    throw new Error(
      `${what}: no visible label matched ${pattern}. Saw (first 40): ${texts.slice(0, 40).join(" | ")}`,
    );
  }
  return hit;
}

async function runStep(ctx, def) {
  const record = {
    id: def.id,
    title: def.title,
    result: RESULT.SKIPPED,
    detail: "",
    screenshots: [],
    transcripts: [],
  };
  run.steps.push(record);
  const skip = def.gate?.(ctx);
  if (skip) {
    record.detail = skip;
    log(`${def.id}: SKIPPED -- ${skip}`);
    return record;
  }
  try {
    const outcome = await def.run(ctx, record);
    record.result = outcome.result;
    record.detail = redact(outcome.detail ?? "");
    if (outcome.facts) record.facts = outcome.facts;
  } catch (error) {
    record.result = RESULT.FAIL;
    record.detail = redact(error?.message ?? String(error));
    if (ctx.page && !record.screenshots.length)
      await shot(ctx.page, record, "-failure").catch(() => {});
  }
  if (def.onFail && record.result === RESULT.FAIL) def.onFail(ctx, record);
  log(`${def.id}: ${record.result}${record.detail ? ` -- ${record.detail}` : ""}`);
  return record;
}

const needs = (key, what) => (ctx) => (ctx[key] ? null : `prerequisite failed: ${what}`);

async function openTab(page, key) {
  if (ORGANISATION_VIEWS.has(key)) {
    const organisation = page.getByTestId("organization-tab-organisation");
    if (await organisation.count()) await pressTab(page, "organisation");
  }
  const tab = page.getByTestId(`organization-tab-${key}`);
  if (!(await tab.count()))
    throw new Error(
      `no organization-tab-${key} test id: the installed plugin predates J6 (control repo 93398d84)`,
    );
  // B-1: the walkthrough's tab clicks go through the same guard as --pillars. "task" (Manage task) is allowed here
  // explicitly: it only opens a read-only sheet, and the walkthrough never presses anything inside it.
  if (!TAB_KEYS.has(key) && key !== "task")
    throw new Error(`refused to press organization-tab-${key}: not a known tab`);
  await guardLabel(tab.first(), key);
  await tab.first().click();
  await delay(750);
}

/**
 * J6: Fulcra binds Escape to "Interrupt agent" (packages/app/src/keyboard/keyboard-shortcuts.ts). With a
 * conversation open in this instance, Escape would interrupt somebody's live session. This harness never needs
 * it, so the key is refused outright rather than trusted to the author of the next step.
 */
function forbidEscape(page) {
  const press = page.keyboard.press.bind(page.keyboard);
  page.keyboard.press = async (key, options) => {
    if (/(^|\+)(Escape|Esc)$/i.test(String(key)))
      throw new Error("Escape is refused: Fulcra binds it to Interrupt agent");
    return press(key, options);
  };
  return page;
}

/**
 * J0: the only way the harness presses a Command Centre tab. Refuses anything but a known tab key, and anything
 * whose accessible name reads like an action, so a changed locator can never press "Send" or "Grant".
 */
const TAB_KEYS = new Set([
  ...PILLARS,
  ...ORGANISATION_VIEWS,
  "organisation",
  "sessions",
  "trackers",
  "fleet",
]);
/** Refuses a tab whose accessible name (or text) reads like an action, whatever its key. */
async function guardLabel(tab, key) {
  const label =
    (await tab.getAttribute("aria-label").catch(() => null)) ??
    (await tab.textContent().catch(() => "")) ??
    "";
  if (DENY_WORDS.test(label))
    throw new Error(`refused to press organization-tab-${key}: its label reads like an action`);
}
async function pressTab(page, key) {
  if (!TAB_KEYS.has(key) || key === "task")
    throw new Error(`refused to press organization-tab-${key}: not a read-only tab`);
  const tab = page.getByTestId(`organization-tab-${key}`).first();
  await guardLabel(tab, key);
  await tab.click();
  await delay(750);
}

/** The capture plan for --pillars: one file per tab, size and scheme. */
function pillarPlan(pillars = PILLARS) {
  return PILLAR_SIZES.flatMap((size) =>
    PILLAR_SCHEMES.flatMap((scheme) =>
      pillars.map((pillar) => ({
        pillar,
        size,
        scheme,
        name: `${pillar}-${size.width}x${size.height}-${scheme}`,
      })),
    ),
  );
}

/** --pillars: every ready tab, at 1280x800 and 390x844, dark and light, into FULCRA_PILLAR_OUT. Read-only. */
async function capturePillars(ctx) {
  const out = process.env.FULCRA_PILLAR_OUT ?? path.join(EVIDENCE_DIR, "pillars");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const { page } = ctx;
  await page.getByTestId(SIDEBAR_TEST_ID).first().click();
  await page
    .getByTestId("organization-tab-organisation")
    .first()
    .waitFor({ state: "visible" })
    .catch(() => {
      throw new Error(
        "no organization-tab-organisation: the installed plugin predates the J0 regroup",
      );
    });
  for (const shotPlan of pillarPlan()) {
    const record = {
      id: shotPlan.name,
      title: `${shotPlan.pillar} at ${shotPlan.size.width}x${shotPlan.size.height}, ${shotPlan.scheme}`,
      result: RESULT.SKIPPED,
      detail: "",
      screenshots: [],
      transcripts: [],
    };
    run.steps.push(record);
    try {
      await page.setViewportSize(shotPlan.size);
      await page.emulateMedia({ colorScheme: shotPlan.scheme });
      await pressTab(page, shotPlan.pillar);
      await delay(1500);
      const entries = await shot(page, record, "", out);
      const leaks = personalScan.transcriptFindings(entries, personalNames);
      record.result = leaks.length && PERSONAL_GATE === "assert" ? RESULT.FAIL : RESULT.PASS;
      record.detail = leaks.length
        ? `personal data: ${[...new Set(leaks.map((f) => f.kind))].join(", ")}`
        : "";
    } catch (error) {
      record.result = RESULT.FAIL;
      record.detail = redact(error?.message ?? String(error));
    }
    log(`${record.id}: ${record.result}${record.detail ? ` -- ${record.detail}` : ""}`);
  }
}

async function backToLeadership(page) {
  const back = page.getByLabel("Back to leadership", { exact: true });
  if (await back.count()) await back.first().click();
  await openTab(page, TABS.leadership);
}

/** A step for a surface that is still in design: capture where it will be, look for its marker. */
function pendingSurface(id, title, markerKey, where) {
  return {
    id,
    title,
    gate: needs("surfaceOpen", "the organization surface did not open"),
    run: async (ctx, record) => {
      await where(ctx.page);
      const entries = await shot(ctx.page, record);
      const seenOnSurface = [
        ...surfaceTexts(entries),
        ...run.allLabels.filter((e) => e.region === "surface").map((e) => e.text),
      ];
      const marker = PENDING_SURFACES[markerKey];
      const hit = seenOnSurface.find((text) => marker.test(text));
      if (hit) return { result: RESULT.PASS, detail: `surface label found: "${hit}"` };
      return {
        result: RESULT.NOT_PRESENT,
        detail: `no surface label matched ${marker} on any captured view; screenshot shows where it belongs`,
      };
    },
  };
}

const STEPS = [
  {
    id: "01-launch",
    title: "Fresh profile, before any host is added",
    run: async (ctx, record) => {
      // The renderer paints "Loading…" first; the welcome flow is the first settled state.
      await ctx.page.getByTestId("welcome-direct-connection").waitFor({ state: "visible" });
      const entries = await shot(ctx.page, record);
      ctx.launched = true;
      requireLabel(
        entries.map((e) => e.text),
        /\S/,
        "launch view",
      );
      return { result: RESULT.PASS };
    },
  },
  {
    id: "02-connect",
    title: `Add the host ${HOST}:${PORT} through the welcome flow`,
    gate: needs("launched", "the app did not render"),
    run: async (ctx, record) => {
      const { page } = ctx;
      // testIDs the app's own e2e uses.
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("direct-host-input").fill(HOST);
      await page.getByTestId("direct-port-input").fill(PORT);
      await shot(page, record, "-form");
      await page.getByTestId("direct-password-input").fill(ctx.password);
      await page.getByTestId("direct-host-submit").click();
      await page.waitForURL((url) => !url.pathname.startsWith("/welcome"), {
        timeout: STEP_TIMEOUT_MS,
      });
      await page.getByTestId(SIDEBAR_TEST_ID).first().waitFor({ state: "visible" });
      const entries = await shot(page, record);
      requireLabel(
        entries.map((e) => e.text),
        new RegExp(`^${SIDEBAR_ITEM.replace(/[()]/g, "\\$&")}$`),
        "sidebar entry of the organization surface",
      );
      ctx.connected = true;
      return { result: RESULT.PASS };
    },
  },
  {
    id: "03-prime",
    title: "Prime orchestrator (Leadership tab)",
    gate: needs("connected", "host connection"),
    run: async (ctx, record) => {
      const { page } = ctx;
      await page.getByTestId(SIDEBAR_TEST_ID).first().click();
      // The surface opens on the Work map; the prime is on the Leadership tab.
      await openTab(page, TABS.leadership);
      await page.getByText(SURFACE_MARKER, { exact: false }).first().waitFor({ state: "visible" });
      ctx.surfaceOpen = true;
      // The surface says "Reading recorded leadership…" until the first observation arrives.
      await page
        .getByText("Reading recorded leadership", { exact: false })
        .waitFor({ state: "hidden" })
        .catch(() => {});
      const texts = surfaceTexts(await shot(page, record));
      // The surface renders whether or not it could read the controller, and says so in words.
      // A surface that cannot name a prime orchestrator has not shown the prime, however well it renders.
      const unreadable = texts.filter((t) =>
        /could not be read|is unavailable|cannot be shown|observation unavailable|not answering yet|did not answer|slow to answer/i.test(
          t,
        ),
      );
      if (unreadable.length)
        throw new Error(
          `surface opened but could not read the controller: ${unreadable.join(" // ")}`,
        );
      const primeSeat = requireLabel(texts, /^PRIME ORCHESTRATOR · \S+/, "prime orchestrator");
      const warnings = texts.filter((t) =>
        /incomplete|not in (this|the current) observation|re-confirm|not current|may be out of date|^Last updated/i.test(
          t,
        ),
      );
      const projects = texts.filter((t) => / · (led|needs an orchestrator)$/.test(t));
      return {
        result: RESULT.PASS,
        detail: warnings.length ? `app warns: ${warnings.join(" // ")}` : "",
        facts: { primeSeat, crossProject: projects, warnings },
      };
    },
  },
  {
    id: "04-prime-inbox",
    title: "Prime inbox (retained updates to the prime seat)",
    gate: needs("surfaceOpen", "the organization surface did not open"),
    run: async (ctx, record) => {
      const { page } = ctx;
      const inbox = page.getByLabel(/^Read retained updates from .+, prime seat .+$/);
      if (!(await inbox.count())) {
        const texts = surfaceTexts(await shot(page, record));
        const why = texts.filter((t) => /not in (this|the current) observation/i.test(t));
        throw new Error(
          `no "Read retained updates" control for a prime seat${why.length ? `; the app says: ${why.join(" // ")}` : ""}`,
        );
      }
      const opener = await inbox.first().getAttribute("aria-label");
      await inbox.first().click();
      await page.getByLabel("Back to leadership", { exact: true }).waitFor({ state: "visible" });
      await delay(1000);
      const texts = surfaceTexts(await shot(page, record));
      await backToLeadership(page);
      return {
        result: RESULT.PASS,
        detail: `opened via "${opener}"`,
        facts: { opener, labelsShown: texts.length },
      };
    },
  },
  {
    id: "05-project-orchestrators",
    title: `Project orchestrators (project: ${PROJECT_NAME})`,
    gate: needs("surfaceOpen", "the organization surface did not open"),
    run: async (ctx, record) => {
      const { page } = ctx;
      // Scoped by the surface's own accessible name. getByText("Orca platform") once matched the
      // SIDEBAR workspace "Orca platform slice worker" and passed without leaving the prime view;
      // "Project overview: <name>" is an aria-label, so only getByLabel finds it.
      const overview = page
        .getByLabel(`Project overview: ${PROJECT_NAME}`, { exact: true })
        .first();
      await overview.scrollIntoViewIfNeeded();
      await overview.click();
      await page
        .getByText("PROJECT ORCHESTRATOR", { exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      const texts = surfaceTexts(await shot(page, record));
      requireLabel(texts, new RegExp(`^${PROJECT_NAME}$`), "project view");
      requireLabel(texts, /^PROJECT ORCHESTRATOR$/, "project orchestrator heading");
      // Anchored label shapes: /leader/i once recorded the sidebar workspace "Portable leadership
      // checklist independent reviewer" as the orchestrator.
      const orchestrator = requireLabel(
        texts,
        /^Talk to .+, project orchestrator(?: ↗)?$/,
        "named project orchestrator",
      );
      const status = requireLabel(
        texts,
        /^(Claude|Codex) · \S+ · \w+$/,
        "orchestrator provider, model and status",
      );
      const warnings = texts.filter((t) => /re-confirm|has changed since/i.test(t));
      ctx.projectOpen = true;
      return {
        result: RESULT.PASS,
        detail: warnings.length ? `app warns: ${warnings.join(" // ")}` : "",
        facts: { orchestrator, status, warnings },
      };
    },
  },
  {
    id: "06-sessions",
    title: "Sessions recorded under the project",
    gate: needs("projectOpen", "the project view did not open"),
    run: async (ctx, record) => {
      const { page } = ctx;
      // The list is collapsed behind a disclosure; expanding it is client state only. The walkthrough
      // this grew from asserted "Open the session this request produced", which the plugin has since
      // moved to the workstream management view: it is recorded here when visible, not required.
      const toggle = page.getByLabel("Sessions in this project", { exact: true }).first();
      await toggle.scrollIntoViewIfNeeded();
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      const firstRow = page.getByLabel(/^Open session: .+/).first();
      await firstRow.waitFor({ state: "visible" });
      await firstRow.scrollIntoViewIfNeeded();
      const texts = surfaceTexts(await shot(page, record));
      const saved = texts.find((t) => /^\d+ saved conversations?$/.test(t)) ?? "(no count shown)";
      const projectSessions = texts.filter((t) => /^Open session: .+/.test(t));
      const childSessions = texts.filter((t) =>
        /^Open the session this request produced: .+/.test(t),
      );
      if (!projectSessions.length)
        throw new Error("the project view listed no saved session by name");
      return {
        result: RESULT.PASS,
        detail: `app says "${saved}"; ${projectSessions.length} distinct named rows`,
        facts: { saved, projectSessions: projectSessions.slice(0, 20), childSessions },
      };
    },
  },
  pendingSurface("07-work-view", "Work view (J2)", "j2", (page) => openTab(page, TABS.liveWork)),
  pendingSurface("08-issues", "Issues (J3)", "j3", (page) => openTab(page, TABS.workstreams)),
  pendingSurface("09-archify-map", "Archify map (J4)", "j4", async (page) => {
    await openTab(page, TABS.leadership);
    const overview = page.getByLabel(`Project overview: ${PROJECT_NAME}`, { exact: true }).first();
    if (await overview.count()) await overview.scrollIntoViewIfNeeded();
  }),
  pendingSurface("10-adw-evidence", "ADW evidence", "adw", (page) =>
    openTab(page, TABS.workstreams),
  ),
  pendingSurface(
    "11-ingress-status",
    "OpenClaw / Discord ingress status",
    "ingress",
    async (page) => {
      await openTab(page, TABS.leadership);
      await page.getByText(SURFACE_MARKER, { exact: false }).first().scrollIntoViewIfNeeded();
    },
  ),
  {
    id: "12-claude-sessions",
    title: "Claude sessions (provider, model and status in words)",
    gate: needs("surfaceOpen", "the organization surface did not open"),
    run: async (ctx, record) => {
      const { page } = ctx;
      await openTab(page, TABS.liveWork);
      const entries = await shot(page, record);
      const all = [
        ...surfaceTexts(entries),
        ...run.allLabels.filter((e) => e.region === "surface").map((e) => e.text),
      ];
      // The provider row shape only: "<session> without Claude · control human · Idle" is a name.
      const claude = [...new Set(all.filter((t) => /^Claude · [\w.-]+ · .+$/.test(t)))];
      if (!claude.length)
        throw new Error("no surface label names a Claude session with its status");
      return {
        result: RESULT.PASS,
        detail: `${claude.length} Claude labels`,
        facts: { claude: claude.slice(0, 20) },
      };
    },
  },
  {
    id: "13-codex-sessions",
    title: "Codex sessions (date-gated)",
    gate: (ctx) => {
      const gate = codexGate();
      if (!gate.open) return gate.reason;
      return needs("surfaceOpen", "the organization surface did not open")(ctx);
    },
    run: async (ctx, record) => {
      const { page } = ctx;
      await openTab(page, TABS.liveWork);
      const entries = await shot(page, record);
      const all = [
        ...surfaceTexts(entries),
        ...run.allLabels.filter((e) => e.region === "surface").map((e) => e.text),
      ];
      const codex = [...new Set(all.filter((t) => /^Codex · [\w.-]+ · .+$/.test(t)))];
      if (!codex.length)
        return { result: RESULT.NOT_PRESENT, detail: "no surface label names a Codex session" };
      return {
        result: RESULT.PASS,
        detail: `${codex.length} Codex labels`,
        facts: { codex: codex.slice(0, 20) },
      };
    },
  },
  {
    id: "14-recovery",
    title: "Recovery: session status after a host or controller restart",
    gate: needs("surfaceOpen", "the organization surface did not open"),
    run: async (ctx, record) => {
      const { page } = ctx;
      await openTab(page, TABS.liveWork);
      // "Show more work" only raises a client-side row limit; expand until every task is listed.
      const more = page.getByLabel("Show more work", { exact: true });
      for (let i = 0; i < 40 && (await more.count()); i += 1) {
        await more.first().click();
        await delay(300);
      }
      // After a restart the observation can sit on "STALE / unavailable · Connecting". Wait for it
      // to settle without pressing anything, then record whatever state it is in.
      await page
        // J0 wording: "Fulcra is not answering yet; retrying" replaces "· Connecting".
        .getByText(/· Connecting$|^Fulcra is not answering yet/)
        .first()
        .waitFor({ state: "hidden", timeout: RECOVERY_SETTLE_MS })
        .catch(() => {});
      const entries = await shot(page, record);
      const texts = surfaceTexts(entries);
      const rows = parseSessionRows(texts);
      const restart = readRestartContext();
      const observation = texts.filter((t) =>
        /^(STALE|LIVE|FROZEN)\b|· (Connecting|Connected)$|^(May be out of date|Last updated|Updating every|Frozen)\b/.test(
          t,
        ),
      );
      const unavailable = [
        ...new Set(
          [
            ...texts,
            ...run.allLabels.filter((e) => e.region === "surface").map((e) => e.text),
          ].filter((t) =>
            /could not be read|is unavailable|are unavailable|observation unavailable|Connection lost|not current|not answering yet|did not answer|slow to answer|may be out of date/i.test(
              t,
            ),
          ),
        ),
      ];
      const findings = recoveryFindings(rows, restart.localProcesses, LOCAL_HOST_LABEL);
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "recovery.json"),
        `${redact(JSON.stringify({ restart, observation, unavailable, ...findings, rows }, null, 2))}\n`,
        { mode: 0o600 },
      );
      record.transcripts.push("recovery.json");
      if (!rows.length)
        throw new Error(
          `no session status can be read after the restart: Live work says "${observation.join(" / ") || "no observation state"}"` +
            `${unavailable.length ? `; the app says: ${unavailable.join(" // ")}` : ""}` +
            `; daemon up since ${restart.daemonStartedAt ?? "unknown"}, booted ${restart.bootedAt ?? "unknown"}`,
        );
      const parts = [
        `${rows.length} sessions`,
        `${findings.stale.length} stale/unavailable`,
        `${findings.attention.length} need attention`,
        `${findings.claimsLive.length} claim live work`,
        restart.daemonStartedAt
          ? `daemon up since ${restart.daemonStartedAt}`
          : "daemon start unknown",
        restart.bootedAt ? `booted ${restart.bootedAt}` : "",
      ].filter(Boolean);
      if (findings.overClaims.length)
        return {
          result: RESULT.FAIL,
          detail: `${findings.overClaims.map((o) => `${o.claims} ${LOCAL_HOST_LABEL} ${o.provider} session(s) say "Working now"/"Starting conversation" but ${o.processes} ${o.provider} process(es) run here`).join("; ")}. ${parts.join(", ")}`,
          facts: { restart, ...findings },
        };
      return { result: RESULT.PASS, detail: parts.join(", "), facts: { restart, ...findings } };
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Recovery. After a reboot or a daemon/controller restart, a session whose process died can keep
// its last recorded status: J1's session still said "running" with no process after the 23 Sep
// reboot. The surface has no "interrupted" status; sessionStatus() in the plugin's work-labels.ts
// shows running as "Working now" and a stale observation as "Status unavailable". So this step
// lists every session by the status the user sees, and compares what the local host's rows claim
// against the provider processes that actually run on this Mac. Book rows run on the other Mac and
// are listed, not counted.

// The host label rows on this Mac carry (fleet.tsx: "Mini" | "Book" | "Unknown host").
const LOCAL_HOST_LABEL = process.env.FULCRA_LOCAL_HOST_LABEL ?? "Mini";
const DAEMON_PID_FILE = process.env.FULCRA_DAEMON_PID_FILE ?? localMachine("acceptancePluginRoot");
const CONTROLLER_PID_FILE = process.env.FULCRA_CONTROLLER_PID_FILE ?? "";
const RECOVERY_SETTLE_MS = Number(process.env.FULCRA_RECOVERY_SETTLE_MS ?? 90_000);
const LIVE_STATUSES = new Set(["Working now", "Starting conversation"]);
const STALE_STATUSES = new Set(["Status unavailable"]);
const ATTENTION_STATUSES = new Set(["Needs attention", "Needs your permission"]);

/** Live work rows: "↳ <name>" followed by "<host> · <provider> · <status>". */
function parseSessionRows(texts) {
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < texts.length - 1; i += 1) {
    const name = /^↳ (.+)$/.exec(texts[i]);
    const meta = name && /^(Mini|Book|Unknown host) · (\S+) · (.+)$/.exec(texts[i + 1]);
    if (!meta) continue;
    const row = { name: name[1], host: meta[1], provider: meta[2].toLowerCase(), status: meta[3] };
    const key = `${row.name}|${row.host}|${row.provider}|${row.status}`;
    if (!seen.has(key)) rows.push(row);
    seen.add(key);
  }
  return rows;
}

/** Which rows are stale, need attention, or claim live work that the local processes cannot back. */
function recoveryFindings(rows, localProcesses, localHost) {
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const claimsLive = rows.filter((r) => LIVE_STATUSES.has(r.status));
  const overClaims = [];
  for (const provider of new Set(claimsLive.map((r) => r.provider))) {
    const local = claimsLive.filter((r) => r.host === localHost && r.provider === provider);
    const processes = localProcesses?.[provider] ?? 0;
    if (local.length > processes)
      overClaims.push({
        provider,
        claims: local.length,
        processes,
        sessions: local.map((r) => r.name),
      });
  }
  return {
    byStatus,
    stale: rows.filter((r) => STALE_STATUSES.has(r.status)),
    attention: rows.filter((r) => ATTENTION_STATUSES.has(r.status)),
    claimsLive,
    overClaims,
  };
}

/** Boot time, daemon/controller start and provider process counts, all read without changing anything. */
function readRestartContext() {
  const { execFileSync } = require("node:child_process");
  const out = {
    bootedAt: null,
    daemonStartedAt: null,
    controllerStartedAt: null,
    localProcesses: {},
  };
  try {
    const sec = /sec = (\d+)/.exec(
      execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }),
    );
    if (sec) out.bootedAt = new Date(Number(sec[1]) * 1000).toISOString();
  } catch {}
  const startedAt = (file) => {
    if (!file || !fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed.startedAt) return parsed.startedAt;
      if (parsed.pid) return processStart(parsed.pid);
    } catch {
      if (/^\d+$/.test(raw.trim())) return processStart(raw.trim());
    }
    return null;
  };
  const processStart = (pid) => {
    try {
      const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      return lstart.trim() ? new Date(lstart.trim()).toISOString() : null;
    } catch {
      return null;
    }
  };
  out.daemonStartedAt = startedAt(DAEMON_PID_FILE);
  out.controllerStartedAt = startedAt(CONTROLLER_PID_FILE);
  try {
    for (const line of execFileSync("ps", ["-Ao", "comm="], { encoding: "utf8" }).split("\n")) {
      const name = line.trim().split("/").pop();
      if (name === "claude" || name === "codex")
        out.localProcesses[name] = (out.localProcesses[name] ?? 0) + 1;
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------------------------
// Whole-run checks and the summary.

function brandingStep() {
  const record = {
    id: "15-branding",
    title: "J1 branding: visible Orca / Paseo",
    screenshots: [],
    transcripts: ["branding.json"],
  };
  const userNames = harvestUserNames(run.allLabels);
  const hits = brandingHits(run.allLabels, userNames);
  const appText = hits.filter((h) => h.kind === "app-text");
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "branding.json"),
    `${JSON.stringify({ mode: BRANDING_MODE, keptIdentifiers: KEPT_IDENTIFIERS.map(String), appText, userNamed: hits.filter((h) => h.kind === "user-named") }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const summary = `${appText.length} app-text label(s) still say Orca/Paseo, ${hits.length - appText.length} user-named`;
  if (BRANDING_MODE === "off")
    Object.assign(record, { result: RESULT.SKIPPED, detail: "branding mode off" });
  else if (BRANDING_MODE === "assert")
    Object.assign(record, { result: appText.length ? RESULT.FAIL : RESULT.PASS, detail: summary });
  else
    Object.assign(record, {
      result: RESULT.SKIPPED,
      detail: `report mode, not asserted: ${summary}; FULCRA_BRANDING_MODE=assert gates on J1`,
    });
  run.steps.push(record);
}

function personalGateVerdict() {
  if (!run.personal.length) return "PASS";
  return run.personalGate === "assert" ? "FAIL" : "REPORTED";
}

function writeSummary(secretResult) {
  const rows = run.steps.map((s) => {
    const shots = s.screenshots.join(", ") || "-";
    const transcripts = s.transcripts.join(", ") || "-";
    return `| ${s.id} | ${s.title} | **${s.result}** | ${shots} | ${transcripts} | ${(s.detail || "").replace(/\|/g, "\\|")} |`;
  });
  const md = [
    `# Fulcra smoke run ${run.startedAt}`,
    "",
    `App: ${run.app} · host ${run.host} · branding mode ${run.brandingMode} · outcome **${run.outcome}**`,
    "",
    "| Step | Surface | Result | Screenshot | Transcript | Detail |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Secret scan: **${secretResult.pass ? "PASS" : "FAIL"}** (${secretResult.findings} finding(s), ${secretResult.literals} literal secret(s), ${secretScan.SECRET_PATTERNS.length} patterns)`,
    "",
    `Personal-data gate (${run.personalGate}): **${personalGateVerdict()}** (${run.personal.length} capture(s) with a hit, ${personalScan.PATTERNS.length} patterns plus this machine's names)`,
    ...run.personal.map(
      (p) => `- ${p.capture}: ${[...new Set(p.findings.map((f) => f.kind))].join(", ")}`,
    ),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(EVIDENCE_DIR, "SUMMARY.md"), redact(md), { mode: 0o600 });
  const { allLabels: _labels, ...json } = run;
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "summary.json"),
    `${redact(JSON.stringify({ ...json, secretScan: secretResult }, null, 2))}\n`,
    { mode: 0o600 },
  );
}

async function removeUntilGone(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    fs.rmSync(dir, { recursive: true, force: true });
    await delay(1000);
    if (!fs.existsSync(dir)) return true;
  }
  return false;
}

async function main() {
  if (!EVIDENCE_DIR || !SCRATCH_DIR)
    throw new Error("FULCRA_EVIDENCE_DIR and FULCRA_SCRATCH_DIR are required");
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(EVIDENCE_DIR, 0o700);
  const password = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
  if (!password) throw new Error("password file is empty");
  literalSecrets = [password, ...secretScan.readLiteralSecrets(EXTRA_SECRET_FILES)];
  personalNames = personalScan.machineNames();

  const { child, cdpPort, scratch } = await launchApp();
  let browser;
  const ctx = { password };
  try {
    const connected = await connectRenderer(cdpPort);
    browser = connected.browser;
    ctx.page = forbidEscape(connected.page);
    ctx.page.setDefaultTimeout(STEP_TIMEOUT_MS);
    if (process.argv.includes("--pillars")) {
      // Launch and connect as the walkthrough does, then only the per-pillar captures.
      for (const def of STEPS.slice(0, 2)) await runStep(ctx, def);
      if (ctx.connected) await capturePillars(ctx);
    } else for (const def of STEPS) await runStep(ctx, def);
  } catch (error) {
    run.error = redact(error?.message ?? String(error));
    log(`FATAL before steps completed: ${run.error}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5000)]);
    child.kill("SIGKILL");
    // The scratch profile holds the saved host entry, credential included. Electron helper
    // processes can still write into it for a moment after the main process dies (a post-reboot
    // run left "Network Persistent State" behind), so delete until it stays deleted.
    run.scratchRemoved = await removeUntilGone(scratch);
    if (!run.scratchRemoved) log(`scratch profile could not be removed: ${scratch}`);
  }

  finishRun();
}

/** Branding, outcome, summary and the secret scan once the app has closed. */
function finishRun() {
  if (!process.argv.includes("--pillars")) brandingStep();
  const failed = run.steps.filter((s) => s.result === RESULT.FAIL).map((s) => s.id);
  const personalFail = PERSONAL_GATE === "assert" && run.personal.length > 0;
  run.outcome =
    run.error || failed.length || personalFail || !run.scratchRemoved ? "failed" : "completed";
  log(
    `personal-data gate (${PERSONAL_GATE}): ${run.personal.length ? `${run.personal.length} capture(s) with personal data` : "PASS"}`,
  );
  run.finishedAt = new Date().toISOString();
  // Write, scan, then write the summary with the scan result and scan once more so the summary is
  // covered too.
  writeSummary({ pass: true, findings: 0, literals: literalSecrets.length, pending: true });
  let findings = secretScan.scanDirectory(EVIDENCE_DIR, literalSecrets);
  const secretResult = {
    pass: !findings.length,
    findings: findings.length,
    literals: literalSecrets.length,
  };
  if (findings.length) run.outcome = "failed";
  writeSummary(secretResult);
  findings = secretScan.scanDirectory(EVIDENCE_DIR, literalSecrets);
  for (const f of findings) log(`SECRET FOUND: ${f.kind} in ${path.basename(f.file)} @${f.offset}`);
  if (findings.length) run.outcome = "failed";
  log(`secret scan: ${findings.length ? "FAIL" : "PASS"}`);
  log(`outcome ${run.outcome}; evidence in ${EVIDENCE_DIR}`);
  if (run.outcome !== "completed") process.exitCode = 1;
}

/** Checks of the pure parts (gate, redaction, scan, branding) that need neither the app nor a host. */
async function selfTest() {
  const assert = require("node:assert/strict");
  assert.equal(codexGate(new Date(2026, 8, 23, 23, 59)).open, false);
  assert.match(codexGate(new Date(2026, 8, 23, 12)).reason, /gated until 2026-09-24/);
  assert.equal(codexGate(new Date(2026, 8, 24, 0, 0)).open, true);

  literalSecrets = ["controller-secret-value-for-self-test"];
  const fakeKey = ["sk", "ant", "api03", "SELFTEST0000000000000000000000"].join("-");
  assert.equal(redact(`x ${fakeKey} y`), `x ${secretScan.REDACTED} y`);
  assert.equal(redact("pw controller-secret-value-for-self-test"), `pw ${secretScan.REDACTED}`);

  const entries = [
    { text: "Loading Orca", region: "surface", step: "01" },
    { text: "Project overview: Orca platform", region: "surface", step: "03" },
    { text: "Orca platform", region: "surface", step: "03" },
    { text: "orca-organization-next", region: "surface", step: "03" },
    { text: "dev.orca.workspace.desktop", region: "surface", step: "03" },
    { text: "Fulcra", region: "sidebar", step: "03" },
  ];
  const hits = brandingHits(entries, harvestUserNames(entries));
  assert.deepEqual(
    hits.map((h) => [h.text, h.kind]),
    [
      ["Loading Orca", "app-text"],
      ["Project overview: Orca platform", "user-named"],
      ["Orca platform", "user-named"],
    ],
  );
  const rows = parseSessionRows([
    "↳ J1 branding worker",
    "Mini · claude · Working now",
    "↳ Book lead",
    "Book · claude · Working now",
    "↳ Old canary",
    "Mini · claude · Status unavailable",
    "↳ Reviewer",
    "Mini · codex · Idle",
  ]);
  assert.equal(rows.length, 4);
  // The J1 symptom after the reboot: "running" on this Mac with no process behind it.
  const noProcess = recoveryFindings(rows, { codex: 3 }, "Mini");
  assert.deepEqual(noProcess.overClaims, [
    { provider: "claude", claims: 1, processes: 0, sessions: ["J1 branding worker"] },
  ]);
  assert.equal(noProcess.stale[0].name, "Old canary");
  // Book rows run on the other Mac and never count against local processes.
  assert.deepEqual(recoveryFindings(rows, { claude: 1 }, "Mini").overClaims, []);
  // J6: Escape is refused; every other key passes through.
  const pressed = [];
  const fake = forbidEscape({
    keyboard: {
      press: async (key) => {
        pressed.push(key);
      },
    },
  });
  await fake.keyboard.press("Tab");
  for (const key of ["Escape", "Esc", "Shift+Escape"])
    await assert.rejects(fake.keyboard.press(key), /Escape is refused/);
  assert.deepEqual(pressed, ["Tab"]);
  assert.equal(SIDEBAR_TEST_ID, `plugin-sidebar-${PLUGIN_ID}-organization`);

  // J0 personal-data gate: the contract cases (same as refs.test.ts), plus this machine's names.
  for (const [text, kind] of personalScan.CASES.hits)
    assert.ok(personalScan.personalMatches(text).includes(kind), `${text} -> ${kind}`);
  for (const text of personalScan.CASES.clean)
    assert.deepEqual(personalScan.personalMatches(text), [], text);
  const names = personalScan.machineNames(
    { FULCRA_PERSONAL_NAMES: "Ada Example, al" },
    () => "Ada Lovelace",
    () => "Adas-Mac-mini.example",
  );
  for (const name of [
    "Ada Lovelace",
    "Ada",
    "Lovelace",
    "Ada Example",
    "Adas-Mac-mini.example",
    "Adas-Mac-mini",
  ])
    assert.ok(names.includes(name), name);
  // B-2: any case, a possessive or plural "s", and the host name; ordinary-word names stay strict.
  const hit = (text, list) =>
    personalScan.transcriptFindings([text], list).some((x) => x.kind === "operator name");
  for (const text of [
    "Adas-Mac-mini is online",
    "ADA LOVELACE",
    "ada lovelace",
    "Ada's notes",
    "on adas-mac-mini",
  ])
    assert.ok(hit(text, ["Ada", "Adas-Mac-mini"]), text);
  for (const text of ["adaptive layout", "Canada"]) assert.equal(hit(text, ["Ada"]), false, text);
  assert.equal(hit("a rose garden", ["Rose"]), false);
  assert.ok(hit("Signed by Rose", ["Rose"]));
  assert.equal(hit("an amber light", ["Amber"]), false);
  assert.ok(!names.includes("al"), "names shorter than three letters are ignored");
  const leaks = personalScan.transcriptFindings(
    [
      { text: "Requested by Ada on Monday", region: "surface" },
      { text: "adaptive layout", region: "surface" },
      { text: "Settings", region: "sidebar" },
      "See /Users/ada/x",
    ],
    ["Ada"],
  );
  assert.deepEqual(
    leaks,
    [
      { kind: "operator name", index: 0, region: "surface" },
      { kind: "macOS user path", index: 3, region: null },
      { kind: "operator name", index: 3, region: null },
    ],
    "B-2: the name inside a home path is caught too",
  );
  assert.ok(!JSON.stringify(leaks).includes("Requested"), "findings never carry the matched text");

  // J0 per-pillar capture plan: every ready tab at both sizes, dark and light.
  const plan = pillarPlan(["organisation", "sessions", "trackers"]);
  assert.equal(plan.length, 12);
  assert.deepEqual(
    plan.slice(0, 3).map((p) => p.name),
    ["organisation-1280x800-dark", "sessions-1280x800-dark", "trackers-1280x800-dark"],
  );
  assert.ok(plan.some((p) => p.name === "trackers-390x844-light"));

  // J0 read-only by construction: only tabs are pressed, never Manage task, never anything that reads like an action.
  const pressed2 = [];
  const fakePage = (labels = {}) => ({
    getByTestId: (id) => {
      const key = id.replace("organization-tab-", "");
      const el = {
        getAttribute: async () => labels[key] ?? key,
        textContent: async () => labels[key] ?? key,
        click: async () => pressed2.push(key),
      };
      return { first: () => el, count: async () => 1 };
    },
  });
  await pressTab(fakePage(), "sessions");
  await assert.rejects(pressTab(fakePage(), "task"), /refused/);
  await assert.rejects(pressTab(fakePage(), "send-message"), /refused/);
  await assert.rejects(
    pressTab(fakePage({ trackers: "Grant access" }), "trackers"),
    /reads like an action/,
  );
  pressed2.length = 0;
  await openTab(fakePage(), "leadership");
  assert.deepEqual(
    pressed2,
    ["organisation", "leadership"],
    "an Organisation view selects Organisation first",
  );
  // B-1: the walkthrough path is guarded too; Manage task is allowed; an action-like label or unknown key is not.
  pressed2.length = 0;
  await openTab(fakePage({ task: "Manage task" }), "task");
  assert.deepEqual(pressed2, ["organisation", "task"]);
  await assert.rejects(
    openTab(fakePage({ fleet: "Send to all sessions" }), "fleet"),
    /reads like an action/,
  );
  await assert.rejects(openTab(fakePage(), "delete-everything"), /not a known tab/);
  console.log(
    "[smoke] self-test PASS (codex gate, redaction, branding, recovery classification, escape guard, personal-data gate, pillar plan, tab guard)",
  );
}

module.exports = {
  pillarPlan,
  codexGate,
  brandingHits,
  harvestUserNames,
  parseSessionRows,
  recoveryFindings,
  PENDING_SURFACES,
};

if (require.main !== module) {
  // Loaded for its pure helpers (e.g. re-checking branding against saved transcripts).
} else if (process.argv.includes("--self-test"))
  selfTest().catch((error) => {
    console.error(`[smoke] self-test FAIL: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
else
  main().catch((error) => {
    console.error(`[smoke] fatal: ${redact(error?.message ?? String(error))}`);
    process.exitCode = 1;
  });

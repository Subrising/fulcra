#!/usr/bin/env node
/**
 * Personal-data gate for screenshot evidence. Every capture's visible-label transcript is
 * checked, and any hit fails the run: a screenshot that shows a personal path, a private host name, an email,
 * a token or the operator's own name is not publishable.
 *
 *   node packages/desktop/e2e/smoke-personal-scan.js <dir>...   # scans every *.labels.json under each dir
 *
 * PATTERNS is a small personal-data pattern set,
 * which the product cannot import. Both sides assert the same hit and non-hit cases (CASES below and refs.test.ts);
 * change them together. Names are not in the contract list and are never written here: they are read from this
 * machine at run time (the account name and its full name) plus FULCRA_PERSONAL_NAMES (comma-separated).
 *
 * Findings name the file, the kind and the label's index. They never print the matched value.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PATTERNS = [
  { name: "macOS user path", re: /\/Users\// },
  { name: "mounted volume path", re: /\/Volumes\// },
  { name: "Linux home path", re: /\/home\// },
  { name: "home-relative path", re: /~\// },
  { name: "Tailscale hostname", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i },
  { name: "local network hostname", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local(?![a-z0-9-]|\.[a-z0-9])/i },
  { name: "email address", re: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i },
  // Anchored and followed by a token body, so "low-risk-first" and "desk-based" pass.
  { name: "access token", re: /(?<![A-Za-z0-9])(ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{8,}/ },
];
// The same cases refs.test.ts asserts, so the two lists cannot drift apart unnoticed.
const CASES = {
  hits: [
    ["See /Users/someone/notes", "macOS user path"], ["on /Volumes/disk/x", "mounted volume path"], ["in /home/dev", "Linux home path"],
    ["under ~/vault", "home-relative path"], ["host host.example-tailnet.ts.net", "Tailscale hostname"], ["Connected to Someones-Mac-mini.local.", "local network hostname"],
    ["mini.local:6767", "local network hostname"], ["mail a.person@example.com", "email address"],
    ["token ghp_abcdefgh12", "access token"], ["gho_ABCDEFGH1234", "access token"], ["github_pat_11AAbbCCdd", "access token"],
    ["sk-live-abc123", "access token"], ["xoxb-12345678", "access token"], ["xoxp-9abcdefgh", "access token"],
  ],
  // "low-risk-first" is a regression phrase: it must never be flagged.
  clean: ["Finish the task-list first", "Loads config.local.json", "Local copy of the website", "The risk-free option", "Users and volumes", "Ask on Discord", "desk-top", "sk-learn", "ghp_short", "A low-risk-first rollout", "desk-based, risk-averse and task-scoped"],
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The operator's names on this machine, read now and never stored: account name, full name and its parts, and (B-2)
 * the machine's host name and its first label, which usually carry the owner's name ("<Name>s-Mac-mini").
 */
function machineNames(env = process.env, readFullName = defaultFullName, readHostname = () => os.hostname()) {
  const names = new Set();
  const add = (value) => {
    const clean = String(value ?? "").trim();
    if (clean.length >= 3) names.add(clean);
  };
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {}
  add(user);
  const full = readFullName(user);
  add(full);
  for (const part of String(full ?? "").split(/\s+/)) add(part);
  for (const extra of String(env.FULCRA_PERSONAL_NAMES ?? "").split(",")) add(extra);
  let host = "";
  try { host = readHostname(); } catch {}
  add(host);
  add(String(host ?? "").split(".")[0]);
  return [...names];
}
function defaultFullName(user) {
  if (process.platform !== "darwin" || !user) return "";
  try {
    return execFileSync("/usr/bin/id", ["-F", user], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
// B-2: a name matches in any case, at a word start, and may be followed by a plural or possessive "s"/"'s", so
// "Adas-Mac-mini", "ADA LOVELACE" and "ada lovelace" are all caught. Names that are also ordinary English words keep
// the stricter rule (whole word, as capitalised), so "the gray button" or "an amber light" is not a hit.
const COMMON_WORD_NAMES = new Set(["amber", "rose", "gray", "grey", "may", "june", "april", "will", "mark", "bill", "frank", "grace", "joy", "hope", "dawn", "sky", "summer", "hunter", "baker", "cook", "black", "white", "brown", "green", "young", "king", "page"]);
const nameMatchers = (names) =>
  names.map((name) => ({
    name,
    re: COMMON_WORD_NAMES.has(name.toLowerCase())
      ? new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?![A-Za-z0-9])`, /[A-Z]/.test(name) ? "" : "i")
      : new RegExp(`(?<![A-Za-z0-9])${escape(name)}(?:'?s)?(?![A-Za-z0-9])`, "i"),
  }));

/** The kinds of personal data a text holds; empty when it may be published. */
function personalMatches(text, matchers = []) {
  const kinds = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  if (matchers.some((m) => m.re.test(text))) kinds.push("operator name");
  return kinds;
}
/** Findings for one transcript: `{ kind, index, region }`, never the matched text. */
function transcriptFindings(labels, names = []) {
  const matchers = nameMatchers(names);
  return labels.flatMap((label, index) =>
    personalMatches(typeof label === "string" ? label : label.text, matchers).map((kind) => ({
      kind,
      index,
      region: typeof label === "string" ? null : (label.region ?? null),
    })),
  );
}
function scanTranscripts(dir, names = []) {
  const findings = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".labels.json")) {
        const { labels = [] } = JSON.parse(fs.readFileSync(full, "utf8"));
        for (const f of transcriptFindings(labels, names)) findings.push({ file: full, ...f });
      }
    }
  };
  walk(dir);
  return findings;
}

function main(argv) {
  if (!argv.length) {
    console.error("usage: smoke-personal-scan.js <dir>...");
    return 2;
  }
  const names = machineNames();
  let total = 0;
  for (const dir of argv) {
    const findings = scanTranscripts(dir, names);
    total += findings.length;
    for (const f of findings) console.log(`[personal-scan] FOUND ${f.kind} in ${path.relative(dir, f.file)} label #${f.index}`);
  }
  console.log(`[personal-scan] ${total ? "FAIL" : "PASS"}: ${total} finding(s) (${PATTERNS.length} patterns, ${names.length} machine name(s))`);
  return total ? 1 : 0;
}

module.exports = { PATTERNS, CASES, machineNames, personalMatches, transcriptFindings, scanTranscripts };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

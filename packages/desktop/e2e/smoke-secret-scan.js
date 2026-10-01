#!/usr/bin/env node
/**
 * Secret scan for smoke-test evidence. The walkthrough redacts before it writes; this is the check
 * that the redaction held. It fails (exit 1) when any known secret shape, or the literal value of any
 * secret file it is given, appears in an evidence file.
 *
 *   node packages/desktop/e2e/smoke-secret-scan.js <dir> [--secret-file <path>]...
 *
 * Text files are scanned as UTF-8. PNGs are scanned for literal secrets only (a screenshot stores
 * pixels, not text, so a pattern match there would be noise); the pixels themselves are protected by
 * the DOM scrub that runs before every capture, not by this scan.
 *
 * Findings name the file, the pattern and an offset. They never print the matched value.
 */
const fs = require("node:fs");
const path = require("node:path");

// Known credential shapes. Each one is specific enough that a hit in a UI transcript is a leak,
// not a false positive: generic "long random string" shapes are deliberately left out because
// session and request ids would trip them. Literal secrets (controller/operator secrets) are
// matched by value instead, which is exact.
const SECRET_PATTERNS = [
  { name: "anthropic-api-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-api-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: "discord-bot-token",
    re: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}\b/g,
  },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "bearer-credential", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: "authorization-header", re: /\bAuthorization["']?\s*[:=]\s*["']?(?!«REDACTED»)\S{8,}/gi },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const REDACTED = "«REDACTED»";
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".log", ".html", ".csv"]);

/** Replace every known secret shape and every literal secret in `text`. */
function redactText(text, literals = []) {
  if (text == null) return text;
  let out = String(text);
  for (const literal of literals) if (literal) out = out.split(literal).join(REDACTED);
  for (const { re } of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

function readLiteralSecrets(files) {
  return files
    .map((file) => fs.readFileSync(file, "utf8").trim())
    .filter((value) => value.length >= 8);
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Returns findings `{ file, kind, offset }`; empty means clean. */
function scanDirectory(dir, literals = []) {
  const findings = [];
  for (const file of listFiles(dir)) {
    const ext = path.extname(file).toLowerCase();
    const bytes = fs.readFileSync(file);
    const binary = !TEXT_EXTENSIONS.has(ext);
    const text = bytes.toString(binary ? "latin1" : "utf8");
    literals.forEach((literal, index) => {
      const offset = text.indexOf(literal);
      if (offset !== -1) findings.push({ file, kind: `literal-secret-${index + 1}`, offset });
    });
    if (binary) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      const hit = re.exec(text);
      if (hit) findings.push({ file, kind: name, offset: hit.index });
    }
  }
  return findings;
}

function main(argv) {
  const dirs = [];
  const secretFiles = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--secret-file") secretFiles.push(argv[++i]);
    else dirs.push(argv[i]);
  }
  if (!dirs.length) {
    console.error("usage: smoke-secret-scan.js <dir>... [--secret-file <path>]...");
    return 2;
  }
  const literals = readLiteralSecrets(secretFiles);
  let total = 0;
  for (const dir of dirs) {
    const findings = scanDirectory(dir, literals);
    total += findings.length;
    for (const f of findings)
      console.log(`[secret-scan] FOUND ${f.kind} in ${path.relative(dir, f.file)} @${f.offset}`);
  }
  console.log(
    `[secret-scan] ${total ? "FAIL" : "PASS"}: ${total} finding(s) in ${dirs.join(", ")} ` +
      `(${SECRET_PATTERNS.length} patterns, ${literals.length} literal secret(s))`,
  );
  return total ? 1 : 0;
}

module.exports = { SECRET_PATTERNS, REDACTED, redactText, readLiteralSecrets, scanDirectory };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
// FULCRA: fails when tracked files or commit metadata carry machine data or the owner's personal details.
// The real values are never in the repo: they come from the FULCRA_PRIVATE_PATTERNS CI secret, or from
// local/personal-patterns.tsv on the owner's Macs. Each line is "<flags>\t<regex>" (flags: "" or "i").
// Output names the file or commit, the line and the rule number only, never the matched text.
// Usage: node scripts/check-machine-data.mjs [--commits <rev-range>]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A shape no fixture needs: an iPhone UDID (8 digits, dash, 16 hex).
export const genericRules = [{ id: "device-id", re: /\b0000[0-9]{4}-[0-9A-F]{16}\b/ }];

export function parsePrivateRules(text) {
  return (text ?? "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line, index) => {
      const tab = line.indexOf("\t");
      const flags = tab === -1 ? "i" : line.slice(0, tab);
      const source = tab === -1 ? line : line.slice(tab + 1);
      return { id: `private-${index + 1}`, re: new RegExp(source, flags.replace(/[^imsu]/g, "")) };
    });
}

export function findInText(text, rules, label) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of rules)
      if (rule.re.test(line)) found.push(`${label}:${index + 1} ${rule.id}`);
  });
  return found;
}

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

export function checkFiles(root, files, rules) {
  const found = [];
  for (const file of files) {
    const full = `${root}/${file}`;
    const info = existsSync(full) ? statSync(full) : null;
    if (!info?.isFile() || info.size > 5_000_000) continue;
    const bytes = readFileSync(full);
    if (!isBinary(bytes)) found.push(...findInText(bytes.toString("utf8"), rules, file));
  }
  return found;
}

export function checkCommits(root, range, rules) {
  const log = execFileSync("git", ["log", "--format=%H%x00%an <%ae>%n%cn <%ce>%n%B%x01", range], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const found = [];
  for (const entry of log.split("\x01")) {
    const [id, body] = entry.replace(/^\n/, "").split("\x00");
    if (id && body) found.push(...findInText(body, rules, `commit ${id.slice(0, 12)}`));
  }
  return found;
}

function privateText(root) {
  if (process.env.FULCRA_PRIVATE_PATTERNS) return process.env.FULCRA_PRIVATE_PATTERNS;
  const local = `${root}/local/personal-patterns.tsv`;
  return existsSync(local) ? readFileSync(local, "utf8") : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const privateRules = parsePrivateRules(privateText(root));
  if (!privateRules.length)
    console.log("No private patterns available (fork or local run): checking generic rules only.");
  const rules = [...genericRules, ...privateRules];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const found = checkFiles(root, files, rules);
  const at = process.argv.indexOf("--commits");
  if (at !== -1 && process.argv[at + 1])
    found.push(...checkCommits(root, process.argv[at + 1], rules));
  if (found.length) {
    console.error(`Machine data or personal details found (${found.length}):\n${found.join("\n")}`);
    process.exitCode = 1;
  } else console.log(`No machine data: PASS (${files.length} files, ${rules.length} rules)`);
}

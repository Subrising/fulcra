// The privacy scrubber for free text shown from a session (CONTRACTS v1.14, STEP-THROUGH): prompts, reasoning,
// commands, command output and diff bodies. Every absolute path is placed against the session's project folder:
// inside it becomes a relative path, the folder itself "the project folder", anything else "a file outside the
// project". With no known project folder every absolute path is outside. Last, anything still matching the §1a
// personal-data patterns (an email, a token, a host, a path in an odd spot) is removed, so the result always
// passes noPersonal.
//
// The patterns are the canonical §1a list (shared/cc/refs.mjs, PERSONAL_PATTERNS; exported for this in C1).
import { PERSONAL_PATTERNS, noPersonal } from "./cc/refs";

export const OUTSIDE_PROJECT = "a file outside the project";
export const PROJECT_FOLDER = "the project folder";
const REMOVED = "[removed]";

const WINDOWS_ROOTED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\\)/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const isWindowsPlacement = (cwd: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(cwd);
const storable = (candidate: string) =>
  !!candidate &&
  !candidate.startsWith("/") &&
  !/^[A-Za-z]:/.test(candidate) &&
  candidate.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** `\\?\C:\x` is `C:\x` and `\\?\UNC\server\share\x` is `\\server\share\x`. */
function withoutExtendedLengthPrefix(value: string): string {
  if (/^\\\\\?\\UNC\\/i.test(value)) return "\\\\" + value.slice(8);
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) return value.slice(4);
  return value;
}

function normalise(parts: string): string {
  const out: string[] = [];
  for (const part of parts.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length || out[out.length - 1] === "..") out.push("..");
      else out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** The part of `target` below `cwd`, keeping its own letter case; Windows placement compares case-insensitively. */
function relativeUnder(cwd: string, target: string, windows: boolean): string | null {
  const slashes = (value: string) => (windows ? value.replace(/\\/g, "/") : value);
  const fold = (value: string) => (windows ? value.toLowerCase() : value);
  const base = normalise(slashes(cwd)),
    original = normalise(slashes(target));
  if (fold(original) === fold(base)) return "";
  if (!fold(original).startsWith(fold(base) + "/")) return null;
  return original.slice(base.length + 1);
}

/**
 * A project-relative path, "" for the project folder itself, or null for anything outside the project (or that
 * cannot be placed without a cwd). The same rules as the host's file index.
 */
export function placePath(filePath: string, cwd: string | null): string | null {
  const trimmed = withoutExtendedLengthPrefix(filePath.trim());
  const base = cwd === null ? null : withoutExtendedLengthPrefix(cwd);
  if (!trimmed || trimmed.startsWith("~") || WINDOWS_DRIVE_RELATIVE.test(trimmed)) return null;
  const windowsRooted = WINDOWS_ROOTED.test(trimmed),
    posixRooted = trimmed.startsWith("/") && !windowsRooted;
  let relative: string | null;
  if (windowsRooted || posixRooted) {
    if (!base || windowsRooted !== isWindowsPlacement(base)) return null;
    relative = relativeUnder(base, trimmed, windowsRooted);
    if (relative === "") return "";
  } else {
    relative = normalise(trimmed.replace(/\\/g, "/"));
  }
  return relative && storable(relative) ? relative : null;
}

// Candidates: POSIX-rooted (not the "//" of a URL or a fraction like 1/2), Windows drive, UNC or extended-length,
// and home-relative paths. A path ends at whitespace, a quote or bracket, or a comma/semicolon.
const PATH_TOKEN =
  /(?:(?<![\w.:/\\~-])\/(?!\/)[^\s'"`<>|;,(){}[\]]*|(?<![\w\\])(?:\\\\\?\\)?[A-Za-z]:[\\/][^\s'"`<>|;,(){}[\]]*|(?<![\w\\])\\\\[^\s\\'"`<>|;,(){}[\]]+\\[^\s'"`<>|;,(){}[\]]*|(?<![\w/])~\/[^\s'"`<>|;,(){}[\]]*)/g;
// Punctuation that ends a sentence rather than a path.
const TRAILING = /[.:!?]+$/;

function placeToken(token: string, cwd: string | null): string {
  const trailing = TRAILING.exec(token)?.[0] ?? "";
  const path = trailing ? token.slice(0, -trailing.length) : token;
  // "/" alone is punctuation; /dev/null is how diffs mark an added or deleted file and names nothing personal.
  if (path === "/" || path === "" || path === "/dev/null") return token;
  // U5-D08: a rooted "path" with no letter or digit is code, not a path: the comment openers "/*" and "/**" in a diff,
  // an operator like "/=". Placing them turned every comment opening into "a file outside the project".
  if (!/[\p{L}\p{N}]/u.test(path)) return token;
  const placed = placePath(path, cwd);
  return (placed === null ? OUTSIDE_PROJECT : placed === "" ? PROJECT_FOLDER : placed) + trailing;
}

/** Removes whatever still matches a personal-data pattern, widening each match to the word it sits in. */
function redactPersonal(text: string): string {
  let out = text;
  for (const { re } of PERSONAL_PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    out = out.replace(new RegExp(`\\S*(?:${re.source})\\S*`, flags), REMOVED);
  }
  return out;
}

/** The scrubbed text: paths placed against `cwd` (null means unknown), then §1a personal data removed. */
export function scrubFreeText(text: string, cwd: string | null): string {
  const placed = text.replace(PATH_TOKEN, (token) => placeToken(token, cwd));
  const scrubbed = noPersonal(placed) ? placed : redactPersonal(placed);
  return noPersonal(scrubbed) ? scrubbed : REMOVED;
}

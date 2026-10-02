import { PERSONAL_PATTERNS, noPersonal } from "../../orca-organization/shared/cc/refs.mjs";
export function heldSubject(text, fallback) {
  let line = typeof text === "string" ? text.split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] : "";
  // Remove the whole whitespace-delimited token, not just a path prefix or token marker.
  line = line
    .replace(/\S+/g, (word) =>
      PERSONAL_PATTERNS.some(({ re }) =>
        new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(word),
      )
        ? "[removed]"
        : word,
    )
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (!line || !noPersonal(line))
    return noPersonal(fallback) ? fallback.slice(0, 80) : "Message waiting from a project lead";
  return line.length <= 80 ? line : line.slice(0, 79).trimEnd() + "…";
}

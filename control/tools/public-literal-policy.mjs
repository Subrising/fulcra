import fs from "node:fs";
import { credentialSource } from "./packaged-review-policy.mjs";

// This checked-in catalog is assessed with the candidate. Caller prose or a
// familiar-looking value never substitutes for its exact artifact/source binding.
const catalog = JSON.parse(
  fs.readFileSync(new URL("./reviewed-public-literals.json", import.meta.url)),
);
const hash = /^[a-f0-9]{64}$/;
const credentials = new RegExp(credentialSource, "i");
const keys = ["kind", "file", "sha256", "line", "offset", "pattern", "context", "source"];
function canonical(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
export function validPublicLiteral(entry) {
  const source = entry?.source;
  if (
    entry?.kind !== "public-literal" ||
    !hash.test(entry.sha256) ||
    !Number.isSafeInteger(entry.line) ||
    entry.line < 1 ||
    !Number.isSafeInteger(entry.offset) ||
    entry.offset < 0 ||
    typeof entry.pattern !== "string" ||
    !entry.pattern ||
    credentials.test(entry.pattern) ||
    typeof entry.context !== "string" ||
    !entry.context ||
    entry.context.length > 300 ||
    !source ||
    !hash.test(source.sha256) ||
    typeof source.literal !== "string" ||
    !source.literal.includes(entry.pattern) ||
    !entry.context.includes(source.literal)
  )
    return false;
  let url;
  try {
    url = new URL(source.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return false;
  if (source.kind === "public-documentation-url") {
    return (
      url.hostname === "qwenlm.github.io" &&
      url.pathname === "/qwen-code-docs/en/users/overview" &&
      source.literal === source.url &&
      source.finalUrl === source.url + "/" &&
      source.status === 200
    );
  }
  if (["public-package-file", "public-compiled-package-constant"].includes(source.kind)) {
    return (
      url.hostname === "registry.npmjs.org" &&
      typeof source.package === "string" &&
      !!source.package &&
      typeof source.version === "string" &&
      !!source.version &&
      typeof source.path === "string" &&
      source.path.startsWith("package/") &&
      !source.path.split("/").includes("..") &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(source.integrity) &&
      (source.kind === "public-package-file"
        ? source.sha256 === entry.sha256
        : typeof source.excerpt === "string" &&
          source.excerpt.length <= 400 &&
          source.excerpt.includes(source.literal))
    );
  }
  const standard =
    source.kind === "public-standard" &&
    ((url.hostname === "www.rfc-editor.org" && /^\/rfc\/rfc\d+\.txt$/.test(url.pathname)) ||
      (url.hostname === "dashif.org" && url.pathname === "/identifiers/content_protection/"));
  const upstream =
    source.kind === "public-upstream-file" &&
    url.hostname === "chromium.googlesource.com" &&
    /^[a-f0-9]{40}$/.test(source.commit) &&
    url.pathname.startsWith(`/chromium/src/+/${source.commit}/`);
  return (
    (standard || upstream) &&
    typeof source.excerpt === "string" &&
    source.excerpt.length <= 400 &&
    source.excerpt.toLowerCase().includes(source.literal.toLowerCase())
  );
}
export function approvedPublicLiteral(entry) {
  return (
    validPublicLiteral(entry) &&
    catalog.some(
      (approved) =>
        validPublicLiteral(approved) &&
        keys.every((key) => canonical(entry[key]) === canonical(approved[key])),
    )
  );
}
export function matchesPublicLiteral(entry, file, digest, hit) {
  return (
    approvedPublicLiteral(entry) &&
    entry.file === file &&
    entry.sha256 === digest &&
    ["line", "offset", "pattern", "context"].every((key) => entry[key] === hit[key])
  );
}

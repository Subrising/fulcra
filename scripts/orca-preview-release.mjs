// Optional manual delivery of an already-built Orca preview to a PRIVATE DRAFT
// GitHub release, for when Actions artifact storage is unavailable.
//
// This never publishes. A draft release does not create its git tag and is
// visible only to collaborators with push access, so an unsigned preview cannot
// become a public download by running this script. It uploads only the files
// recorded in build-manifest.json, after validating the manifest, re-reading
// each file and hashing the exact bytes it sends.
//
// It cannot prevent a human publishing the draft concurrently in the GitHub UI.
// The draft/private rechecks below narrow that window; they do not close it.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ORIGIN = "https://api.github.com";
const UPLOAD_ORIGIN = "https://uploads.github.com";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 16;
const MAX_RELEASE_PAGES = 20;
const RELEASE_PAGE_SIZE = 100;

// A generated preview manifest only ever lists build output and the LICENSE.
const ALLOWED_EXTENSIONS = new Set([".exe", ".zip", ".apk", ".aab", ".json"]);
const ALLOWED_EXACT_NAMES = new Set(["LICENSE"]);
// Defence in depth over the allowlist: refuse anything named like a key or
// credential even when it wears an allowed extension.
const CREDENTIAL_NAME =
  /(^|[._-])(key|keys|keystore|jks|pem|p12|pfx|secret|secrets|token|credential|credentials|password|passwd|env|id_rsa|id_ed25519)([._-]|$)/i;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[A-Za-z0-9.]{1,32})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const target = argv[0];
const confirm = argv.includes("--confirm");
const repoFlagIndex = argv.indexOf("--repo");
const repoArg = repoFlagIndex >= 0 ? argv[repoFlagIndex + 1] : undefined;

function fail(message) {
  throw new Error(message);
}

if (!new Set(["windows", "android"]).has(target)) {
  fail(
    "Usage: node scripts/orca-preview-release.mjs windows|android [--repo owner/name] [--confirm]",
  );
}

// Read from the environment only; a token is never accepted as an argument and
// is never printed, so it cannot reach shell history or a CI log.
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  fail("Set GH_TOKEN (or GITHUB_TOKEN) to a token with contents:write on the private repository");
}

const slug = repoArg || process.env.GITHUB_REPOSITORY;
if (typeof slug !== "string" || slug.length > 200)
  fail("Pass --repo owner/name (or set GITHUB_REPOSITORY)");
const slugParts = slug.split("/");
if (slugParts.length !== 2 || !slugParts.every((part) => SLUG_PART.test(part))) {
  fail(`Unusable repository slug: expected owner/name, got ${slugParts.length} bounded segments`);
}
const [owner, repo] = slugParts;

// ---------------------------------------------------------------------------
// Manifest validation — completed before any listed file or network is touched
// ---------------------------------------------------------------------------

const directory = path.join(root, "artifacts/orca-preview", target);
const manifestPath = path.join(directory, "build-manifest.json");
if (!existsSync(manifestPath)) {
  fail(`No build to deliver: ${path.relative(root, manifestPath)} is missing. Build first.`);
}
const manifestStat = lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
  fail("build-manifest.json must be a regular file within its size bound");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  fail("build-manifest.json is not valid JSON");
}
if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
  fail("build-manifest.json must be an object");
}

if (manifest.sourceDirty !== false) {
  // The refusal stands. Name what the build recorded so the next step is
  // inspecting real paths rather than re-running a 20-minute build blind.
  const recorded = Array.isArray(manifest.sourceStatus)
    ? manifest.sourceStatus.filter((line) => typeof line === "string").slice(0, 50)
    : [];
  const detail = recorded.length
    ? `\nSource status recorded by the build (codes and paths only):\n  ${recorded
        .map((line) => line.slice(0, 200))
        .join("\n  ")}${manifest.sourceStatusTruncated === true ? "\n  … truncated" : ""}`
    : "\nThe build recorded no sourceStatus. Rebuild with a current build script to capture the paths.";
  fail(`Refusing to deliver a build whose manifest does not record sourceDirty: false${detail}`);
}
if (manifest.target !== target) {
  fail(`Manifest records target ${JSON.stringify(manifest.target)}, not ${target}`);
}
if (typeof manifest.sourceCommit !== "string" || !COMMIT.test(manifest.sourceCommit)) {
  fail("build-manifest.json does not record a full 40-character source commit");
}
if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
  fail("build-manifest.json does not record a bounded semantic version");
}
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  fail("build-manifest.json lists no files");
}
if (manifest.files.length > MAX_FILES) {
  fail(`build-manifest.json lists ${manifest.files.length} files; the bound is ${MAX_FILES}`);
}

const manifestName = path.basename(manifestPath);
const seen = new Set([manifestName]);
for (const entry of manifest.files) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("Every manifest file entry must be an object");
  }
  const { name, sha256 } = entry;
  if (typeof name !== "string" || !ASSET_NAME.test(name)) {
    fail(`Unusable manifest file name: ${JSON.stringify(name)}`);
  }
  // Flat, non-hidden names only: no separator, no traversal, no dotfile.
  if (
    name !== path.basename(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..")
  ) {
    fail(`Manifest file name must be a flat basename: ${name}`);
  }
  if (seen.has(name)) fail(`Manifest lists ${name} more than once`);
  seen.add(name);
  if (CREDENTIAL_NAME.test(name)) {
    fail(`Refusing to deliver ${name}: it is named like a key or credential`);
  }
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_EXACT_NAMES.has(name) && !ALLOWED_EXTENSIONS.has(extension)) {
    fail(
      `Refusing to deliver ${name}: ${extension || "no extension"} is not a preview build output`,
    );
  }
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    fail(`Manifest records no valid SHA-256 for ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Filesystem — read once, hash and upload the same bytes
// ---------------------------------------------------------------------------

function loadAsset(name, expectedSha256) {
  const filePath = path.join(directory, name);
  if (path.dirname(filePath) !== directory) fail(`${name} resolves outside the build directory`);
  if (!existsSync(filePath)) fail(`Manifest lists ${name} but it is missing from the build output`);
  // lstat, so a symlink is rejected rather than followed.
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) fail(`${name} is a symlink; refusing to follow it`);
  if (!stat.isFile()) fail(`${name} is not a regular file`);
  if (stat.nlink !== 1) fail(`${name} has ${stat.nlink} hard links; refusing an aliased file`);
  if (stat.size === 0) fail(`${name} is empty`);
  if (stat.size > MAX_ASSET_BYTES) fail(`${name} is larger than the ${MAX_ASSET_BYTES}-byte bound`);

  const body = readFileSync(filePath);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (expectedSha256 !== null && sha256 !== expectedSha256) {
    fail(`${name} does not match its recorded hash; rebuild rather than deliver an altered file`);
  }
  return { name, body, sha256, size: body.length };
}

const assets = [
  ...manifest.files.map((entry) => loadAsset(entry.name, entry.sha256)),
  loadAsset(manifestName, null),
];

// ---------------------------------------------------------------------------
// GitHub — fixed origins, no redirected credentials
// ---------------------------------------------------------------------------

async function request(url, { origin, method = "GET", body, contentType, expect = [200] }) {
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin) {
    fail(`Refusing to send credentials to ${parsed.origin}; only ${origin} is allowed`);
  }
  const response = await fetch(parsed, {
    method,
    // Never follow a redirect with the token attached.
    redirect: "manual",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "orca-preview-release",
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(method !== "GET" && method !== "HEAD" && body !== undefined ? { body } : {}),
  });
  if (response.status >= 300 && response.status < 400) {
    fail(
      `GitHub redirected ${method} ${parsed.pathname} to another location; not resending credentials`,
    );
  }
  if (!expect.includes(response.status)) {
    // GitHub error bodies can echo request content; report status and path only.
    fail(`GitHub API ${method} ${parsed.pathname} failed with ${response.status}`);
  }
  return response.json();
}

const api = (pathname, options = {}) =>
  request(`${API_ORIGIN}${pathname}`, { ...options, origin: API_ORIGIN });

async function assertPrivateRepository(stage) {
  const repository = await api(`/repos/${owner}/${repo}`);
  if (repository.private !== true) {
    fail(`${slug} is not private (${stage}). This delivery mode is only for a private repository.`);
  }
}

async function assertDraft(releaseId, stage) {
  const current = await api(`/repos/${owner}/${repo}/releases/${releaseId}`);
  if (current.draft !== true) {
    fail(
      `Release ${releaseId} is no longer a draft (${stage}). Stopping; this script never writes to a published release.`,
    );
  }
  return current;
}

// Drafts have no tag yet, so GET /releases/tags/{tag} cannot find them. Page the
// list instead, and only conclude "absent" after reaching a definitively short
// page — an uncertain lookup must never lead to creating a second draft.
async function findReleaseByTag(tag) {
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const batch = await api(
      `/repos/${owner}/${repo}/releases?per_page=${RELEASE_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch))
      fail("GitHub returned an unreadable release list; not creating anything");
    const match = batch.find((release) => release.tag_name === tag);
    if (match) return match;
    if (batch.length < RELEASE_PAGE_SIZE) return null;
  }
  fail(
    `Scanned ${
      MAX_RELEASE_PAGES * RELEASE_PAGE_SIZE
    } releases without reaching the end; not creating a possible duplicate`,
  );
}

await assertPrivateRepository("before lookup");

const tag = `orca-preview-${manifest.version}-${target}-${manifest.sourceCommit.slice(0, 12)}`;
const existing = await findReleaseByTag(tag);
if (existing && existing.draft !== true) {
  fail(`Release ${tag} is already published. This script only ever writes to a draft.`);
}
const collisions = (existing?.assets ?? [])
  .filter((asset) => assets.some((candidate) => candidate.name === asset.name))
  .map((asset) => asset.name);
if (collisions.length > 0) {
  // Replacing would mean deleting an asset a human may already have shared.
  fail(
    `Draft ${tag} already has ${collisions.join(
      ", ",
    )}. Remove them yourself or deliver a new build.`,
  );
}

console.log(`Repository: ${slug} (private)`);
console.log(`Draft tag:  ${tag}${existing ? " (existing draft)" : " (new draft)"}`);
console.log(`Commitish:  ${manifest.sourceCommit}`);
console.log(
  `Uploads:    ${assets.map((asset) => `${asset.name} (${asset.size} bytes)`).join(", ")}`,
);
if (!confirm) {
  console.log("\nChecks passed. Re-run with --confirm to create or update the draft release.");
  process.exit(0);
}

const release =
  existing ??
  (await api(`/repos/${owner}/${repo}/releases`, {
    method: "POST",
    contentType: "application/json",
    expect: [201],
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: manifest.sourceCommit,
      name: `Orca ${target} preview ${manifest.version} (${manifest.sourceCommit.slice(0, 12)})`,
      // draft leaves the tag uncreated and the files collaborator-only;
      // prerelease and make_latest stop it ever reading as a current release.
      draft: true,
      prerelease: true,
      make_latest: "false",
      generate_release_notes: false,
      body: [
        `Unsigned ${target} preview built from \`${manifest.sourceCommit}\`.`,
        "",
        "Draft, private distribution only. Not signed, not device-accepted, and not a release.",
        "Verify the SHA-256 values in `build-manifest.json` before running anything here.",
      ].join("\n"),
    }),
  }));

for (const asset of assets) {
  // Recheck immediately before each upload: the draft and the repository must
  // both still be what they were when this run started.
  await assertPrivateRepository("before upload");
  await assertDraft(release.id, "before upload");

  const uploaded = await request(
    `${UPLOAD_ORIGIN}/repos/${owner}/${repo}/releases/${
      release.id
    }/assets?name=${encodeURIComponent(asset.name)}`,
    {
      origin: UPLOAD_ORIGIN,
      method: "POST",
      contentType: "application/octet-stream",
      body: asset.body,
      expect: [201],
    },
  );
  if (uploaded.size !== asset.size) {
    fail(
      `${asset.name} uploaded as ${uploaded.size} bytes, expected ${asset.size}. Remove it and retry.`,
    );
  }
  // GitHub returns `digest` on newer asset responses; check it when present
  // rather than requiring a field that may be absent.
  if (typeof uploaded.digest === "string" && uploaded.digest !== `sha256:${asset.sha256}`) {
    fail(`${asset.name} uploaded with digest ${uploaded.digest}, expected sha256:${asset.sha256}.`);
  }
  console.log(`Uploaded ${asset.name} (${asset.size} bytes, sha256:${asset.sha256})`);
}

await assertPrivateRepository("after upload");
const final = await assertDraft(release.id, "after upload");

console.log(`\nDraft release ready: ${final.html_url}`);
console.log("It is still a draft. Publishing, tagging and signing remain manual human decisions.");

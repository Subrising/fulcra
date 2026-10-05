import assert from "node:assert/strict";
import { it as test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareSite, PUBLIC_URL } from "../scripts/prepare-fulcra-site.mjs";
import { acceptedFrames } from "../public/fulcra/capture-policy.js";
const inventory = JSON.parse(
  await fs.readFile(new URL("../public/fulcra/captures.json", import.meta.url), "utf8"),
);
const target = { ...inventory.target, installedOnRequiredTargets: true };
const frame = {
  id: "projects",
  title: "Projects",
  alt: "Actual latest desktop capture with private labels redacted",
  caption: "Development build",
  src: "assets/captures/projects.png",
  sourceCommit: target.sourceCommit,
  verificationCommit: target.verificationCommit,
  artifactSeal: target.artifactSeal,
  asarSha256: target.asarSha256,
  version: target.version,
  capturedOn: "mac-mini",
  capturedAt: "2026-10-05T00:00:00.000Z",
  sha256: "a".repeat(64),
  actualCapture: true,
  installedCapture: true,
  publicSafe: true,
  width: 1440,
  height: 900,
};
const ready = { status: "verified", target, frames: [frame] };
test("pending latest installed-object input never renders an older or invented substitute", () => {
  assert.deepEqual(acceptedFrames({ ...inventory, status: "pending" }), []);
  assert.deepEqual(
    acceptedFrames({
      ...inventory,
      target: { ...inventory.target, installedOnRequiredTargets: false },
    }),
    [],
  );
});
test("capture metadata binds actual installed identity at capture time, not a stale hardcoded seal", () => {
  assert.deepEqual(acceptedFrames(ready), [frame]);
  assert.deepEqual(acceptedFrames({ ...ready, frames: [null] }), []);
  assert.deepEqual(
    acceptedFrames({ ...ready, target: { ...target, installedOnRequiredTargets: false } }),
    [],
  );
  for (const replacement of [
    { sourceCommit: "older-source" },
    { artifactSeal: "older-seal" },
    { asarSha256: "wrong" },
    { actualCapture: false },
    { installedCapture: false },
    { publicSafe: false },
    { src: "https://example.com/mock.png" },
    { src: "../private.png" },
    { width: 0 },
    { capturedOn: "other" },
    { capturedAt: "invalid" },
    { sha256: "wrong" },
  ])
    assert.deepEqual(acceptedFrames({ ...ready, frames: [{ ...frame, ...replacement }] }), []);
  const newer = { ...target, artifactSeal: "1".repeat(64) };
  assert.deepEqual(acceptedFrames({ ...ready, target: newer }), []);
  assert.deepEqual(
    acceptedFrames({
      ...ready,
      target: newer,
      frames: [{ ...frame, artifactSeal: newer.artifactSeal }],
    }).length,
    1,
  );
});
test("confirmed product narrative and access stay truthful without source caveats dominating", async () => {
  const html = await fs.readFile(new URL("../public/fulcra/index.html", import.meta.url), "utf8");
  assert.match(html, /You set direction/);
  assert.match(html, /One or several primes/);
  assert.match(html, /Own board &amp; tasks/);
  assert.match(html, /Project communications/);
  assert.match(html, /conceptual illustration/);
  assert.match(html, /Implemented in the current source/);
  assert.match(html, /In development/);
  assert.match(html, /data-story="organise"/);
  assert.match(html, /data-story="delegate"/);
  assert.match(html, /data-story="follow"/);
  assert.match(html, /data-story="continue"/);
  assert.match(html, /https:\/\/github.com\/Subrising\/fulcra\/tree\/v0\.2\.0/);
  assert.doesNotMatch(
    html,
    /plausible|testimonials|img\.shields\.io|apps\.apple\.com|play\.google\.com|grants an agent authority|latest.*installed.*verified.*release/i,
  );
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<dialog/);
});
test("all local public references and in-page anchors exist", async () => {
  const url = new URL("../public/fulcra/index.html", import.meta.url);
  const html = await fs.readFile(url, "utf8");
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (ref.startsWith("http")) continue;
    if (ref.startsWith("#")) {
      assert.ok(html.includes(`id="${ref.slice(1)}"`), ref);
      continue;
    }
    await fs.access(new URL(ref, url));
  }
});
test("README brand authority preserves exact published icon and palette", async () => {
  const icon = await fs.readFile(
    new URL("../../app/assets/images/fulcra-v1/icon.svg", import.meta.url),
    "utf8",
  );
  const publicIcon = await fs.readFile(
    new URL("../public/fulcra/assets/fulcra-mark.svg", import.meta.url),
    "utf8",
  );
  assert.equal(publicIcon, icon);
  const css = await fs.readFile(new URL("../public/fulcra/site.css", import.meta.url), "utf8");
  for (const value of ["#5e1623", "#ff8a5b", "#f2e7d5", "#121112", "#faf6f0", '"SF Pro Display"'])
    assert.ok(css.includes(value), value);
  assert.doesNotMatch(css, /Manrope|#ff986d|#161417/);
});

async function exportFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fulcra-public-export-"));
  const source = path.join(root, "source");
  await fs.cp(new URL("../public/fulcra/", import.meta.url), source, { recursive: true });
  await fs.mkdir(path.join(source, "assets/captures"), { recursive: true });
  // Disposable packaging bytes; these never enter the actual website source/export.
  const data = Buffer.from("test capture boundary");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const frames = ["mac-mini", "macbook-pro"].map((capturedOn) =>
    Object.assign({}, frame, {
      id: capturedOn,
      capturedOn,
      src: `assets/captures/${capturedOn}.png`,
      sha256,
    }),
  );
  for (const item of frames) await fs.writeFile(path.join(source, item.src), data);
  await fs.writeFile(path.join(source, "captures.json"), JSON.stringify({ ...ready, frames }));
  return { root, source, frames };
}
test("publication refuses pending or one-host capture input before creating output", async () => {
  const fixture = await exportFixture();
  try {
    const output = path.join(fixture.root, "out");
    await fs.writeFile(
      path.join(fixture.source, "captures.json"),
      JSON.stringify({ ...ready, frames: fixture.frames.slice(0, 1) }),
    );
    await assert.rejects(prepareSite({ source: fixture.source, output }), {
      code: "PUBLIC_CAPTURE_REQUIRED",
    });
    await assert.rejects(fs.access(output));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
test("static publication includes only dedicated assets and absolute project-page sharing URLs", async () => {
  const fixture = await exportFixture();
  try {
    await fs.writeFile(path.join(fixture.source, "private-original.png"), "private canary");
    const output = path.join(fixture.root, "out");
    const result = await prepareSite({ source: fixture.source, output });
    assert.equal(result.captures, 2);
    assert.equal(result.publicUrl, "https://subrising.github.io/fulcra/");
    await assert.rejects(fs.access(path.join(output, "private-original.png")));
    await assert.rejects(fs.access(path.join(output, "social-preview.html")));
    const html = await fs.readFile(path.join(output, "index.html"), "utf8");
    assert.ok(html.includes(`rel="canonical" href="${PUBLIC_URL}"`));
    assert.ok(html.includes(`content="${PUBLIC_URL}assets/social-preview.png"`));
    assert.ok(!html.includes('name="robots" content="noindex"'));
    await assert.rejects(prepareSite({ source: fixture.source, output }), { code: "EEXIST" });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
test("changed derivative bytes or symlinked public assets block publication", async () => {
  const fixture = await exportFixture();
  try {
    const file = path.join(fixture.source, fixture.frames[0].src);
    await fs.writeFile(file, "different bytes");
    await assert.rejects(
      prepareSite({ source: fixture.source }),
      /differ from reviewed derivative/,
    );
    await fs.rm(file);
    await fs.symlink(path.join(fixture.source, fixture.frames[1].src), file);
    await assert.rejects(prepareSite({ source: fixture.source }), /Not a regular public asset/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
test("Pages workflow stays fork/main guarded and uploads only dedicated static output", async () => {
  const workflow = await fs.readFile(
    new URL("../../../.github/workflows/deploy-fulcra-website.yml", import.meta.url),
    "utf8",
  );
  assert.ok(
    workflow.includes("github.repository == 'Subrising/fulcra' && github.ref == 'refs/heads/main'"),
  );
  assert.match(workflow, /path: _fulcra-pages/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(workflow, /wrangler|paseo\.sh|CLOUDFLARE|npm ci|--preview/);
});

test("actual public capture inventory binds both installed hosts and exact PNG derivative bytes", async () => {
  const frames = acceptedFrames(inventory);
  assert.equal(frames.length, 2);
  assert.deepEqual(
    new Set(frames.map((item) => item.capturedOn)),
    new Set(["mac-mini", "macbook-pro"]),
  );
  for (const item of frames) {
    const data = await fs.readFile(new URL(`../public/fulcra/${item.src}`, import.meta.url));
    assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256);
    assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(data.readUInt32BE(16), item.width);
    assert.equal(data.readUInt32BE(20), item.height);
    assert.match(item.caption, /Development build 0\.2\.3/);
  }
  const result = await prepareSite({});
  assert.equal(result.captures, 2);
  assert.equal(result.preview, false);
});

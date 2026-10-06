import assert from "node:assert/strict";
import { it as test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareSite, PUBLIC_URL } from "../scripts/prepare-fulcra-site.mjs";

const site = new URL("../public/fulcra/", import.meta.url);
const read = (name: string) => fs.readFile(new URL(name, site), "utf8");

test("every local reference and in-page anchor exists", async () => {
  const html = await read("index.html");
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (ref.startsWith("http")) continue;
    if (ref.startsWith("#")) {
      assert.ok(html.includes(`id="${ref.slice(1)}"`), ref);
      continue;
    }
    await fs.access(new URL(ref, site));
  }
  for (const [, list] of html.matchAll(/srcset="([^"]+)"/g))
    for (const entry of list.split(",")) await fs.access(new URL(entry.trim().split(" ")[0], site));
});

test("copy stays truthful: real captures, labelled illustration, source-only access", async () => {
  const html = await read("index.html");
  assert.match(html, /Run your AI team/);
  assert.match(html, /Illustration/);
  assert.match(html, /real captures of the Fulcra 0\.2\.3 Mac app/);
  assert.match(html, /no signed download yet/);
  assert.match(
    html,
    /https:\/\/github.com\/Subrising\/fulcra\/blob\/main\/docs\/getting-started\.md/,
  );
  assert.doesNotMatch(html, /testimonial|apps\.apple\.com|play\.google\.com|\.dmg|download now/i);
  assert.match(html, /class="skip"/);
  for (const [, alt] of html.matchAll(/<img [^>]*alt="([^"]*)"/g)) assert.ok(alt !== undefined);
});

test("public files carry no private names or paths", async () => {
  for (const name of ["index.html", "site.css", "social-preview.html"]) {
    const text = await read(name);
    assert.doesNotMatch(text, /\/Users\/|\.local\b|\.ts\.net/i, name);
  }
});

test("brand uses the README Keystone palette and the unchanged app icon", async () => {
  const icon = await fs.readFile(
    new URL("../../app/assets/images/fulcra-v1/icon.svg", import.meta.url),
    "utf8",
  );
  assert.equal(await read("assets/fulcra-mark.svg"), icon);
  const css = await read("site.css");
  for (const value of ["#5e1623", "#ff8a5b", "#f2e7d5", "#121112", '"SF Pro Display"'])
    assert.ok(css.includes(value), value);
  assert.match(css, /prefers-reduced-motion/);
});

test("export includes only site files and adds absolute sharing URLs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fulcra-public-export-"));
  try {
    const source = path.join(root, "source");
    await fs.cp(site, source, { recursive: true });
    await fs.writeFile(path.join(source, "private-original.png"), "private canary");
    await fs.writeFile(path.join(source, "assets/shots/notes.txt"), "not an image");
    const output = path.join(root, "out");
    const result = await prepareSite({ source, output });
    assert.equal(result.publicUrl, PUBLIC_URL);
    await assert.rejects(fs.access(path.join(output, "private-original.png")));
    await assert.rejects(fs.access(path.join(output, "social-preview.html")));
    await assert.rejects(fs.access(path.join(output, "assets/shots/notes.txt")));
    await fs.access(path.join(output, "assets/shots/diff@2x.jpg"));
    await fs.access(path.join(output, ".nojekyll"));
    const html = await fs.readFile(path.join(output, "index.html"), "utf8");
    assert.ok(html.includes(`rel="canonical" href="${PUBLIC_URL}"`));
    assert.ok(html.includes(`content="${PUBLIC_URL}assets/social-preview.png"`));
    assert.ok(!html.includes('content="noindex"'));
    await assert.rejects(prepareSite({ source, output }), { code: "EEXIST" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("export refuses a page that references a missing image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fulcra-public-export-"));
  try {
    const source = path.join(root, "source");
    await fs.cp(site, source, { recursive: true });
    await fs.rm(path.join(source, "assets/shots/review@2x.jpg"));
    await assert.rejects(prepareSite({ source }), /missing image/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Pages workflow stays fork/main guarded and uploads only the static output", async () => {
  const workflow = await fs.readFile(
    new URL("../../../.github/workflows/deploy-fulcra-website.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /github\.repository == 'Subrising\/fulcra'/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /prepare-fulcra-site\.mjs --out _fulcra-pages/);
  assert.match(workflow, /path: _fulcra-pages/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.doesNotMatch(workflow, /wrangler|CLOUDFLARE|npm ci|--preview/);
});

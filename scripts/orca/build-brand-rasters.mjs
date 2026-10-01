#!/usr/bin/env node
// Renders every small brand raster that is not produced by Expo or electron-builder from the
// Keystone source, so no inherited Paseo artwork is left in a shipped or dev surface.
//
//   node scripts/orca/build-brand-rasters.mjs
//
// Source: packages/app/assets/images/fulcra-v1/icon.svg (see the README beside it).
// Status favicons keep the inherited dot colours: blue while an agent runs, green for attention.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const ROOT = path.resolve(import.meta.dirname, "../..");
const APP_IMAGES = path.join(ROOT, "packages/app/assets/images");
const APP_PUBLIC = path.join(ROOT, "packages/app/public");
const DESKTOP_ASSETS = path.join(ROOT, "packages/desktop/assets");

const iconSvg = fs.readFileSync(path.join(APP_IMAGES, "fulcra-v1/icon.svg"), "utf8");
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(iconSvg)[1];

// Square icon: the Keystone field edge to edge. Platforms that round corners do it themselves.
const square = iconSvg;

// Favicon: rounded field so it reads as an app tile in a browser tab, plus an optional status dot.
// The corner radius keeps the inherited favicon's proportion (156 of 700).
function favicon(dot) {
  const field = inner.replace(
    /<rect x="0" y="0" width="1000" height="1000" fill="([^"]+)"\/>/,
    '<rect x="0" y="0" width="1000" height="1000" rx="223" fill="$1"/>',
  );
  const status = dot ? `<circle cx="814" cy="814" r="186" fill="${dot}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="48" height="48">${field}${status}</svg>\n`;
}

const png = (svg, size) =>
  sharp(Buffer.from(svg), { density: 300 }).resize(size, size).png().toBuffer();

async function write(file, data) {
  fs.writeFileSync(file, await data);
  console.log(path.relative(ROOT, file));
}

// ICO with PNG-encoded entries (supported since Windows Vista).
async function ico(sizes) {
  const images = await Promise.all(sizes.map((s) => png(square, s)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 0);
    e.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...images]);
}

async function icns(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-icns-"));
  const set = path.join(dir, "icon.iconset");
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await png(square, s));
    fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await png(square, s * 2));
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", file]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(path.relative(ROOT, file));
}

const DOTS = { "": null, "-running": "#3b82f6", "-attention": "#22c55e" };
for (const scheme of ["dark", "light"]) {
  for (const [suffix, dot] of Object.entries(DOTS)) {
    const svg = favicon(dot);
    const base = path.join(APP_IMAGES, `favicon-${scheme}${suffix}`);
    fs.writeFileSync(`${base}.svg`, svg);
    console.log(path.relative(ROOT, `${base}.svg`));
    await write(`${base}.png`, png(svg, 48));
  }
}
await write(path.join(APP_IMAGES, "notification-icon.png"), png(square, 96));
await write(path.join(APP_IMAGES, "icon.png"), png(square, 1024));
await write(path.join(APP_PUBLIC, "pwa-icon-192.png"), png(square, 192));
await write(path.join(APP_PUBLIC, "pwa-icon-512.png"), png(square, 512));
await write(path.join(APP_PUBLIC, "apple-touch-icon.png"), png(square, 180));

await write(path.join(DESKTOP_ASSETS, "icon.png"), png(square, 1024));
await write(path.join(DESKTOP_ASSETS, "icon-dev.png"), png(square, 1024));
await write(path.join(DESKTOP_ASSETS, "32x32.png"), png(square, 32));
await write(path.join(DESKTOP_ASSETS, "64x64.png"), png(square, 64));
await write(path.join(DESKTOP_ASSETS, "128x128.png"), png(square, 128));
await write(path.join(DESKTOP_ASSETS, "128x128@2x.png"), png(square, 256));
await write(path.join(DESKTOP_ASSETS, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256]));
if (process.platform === "darwin") await icns(path.join(DESKTOP_ASSETS, "icon.icns"));
else console.log("skipped icon.icns: iconutil is macOS-only");

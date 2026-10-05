import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acceptedFrames } from "../public/fulcra/capture-policy.js";

export const PUBLIC_URL = "https://subrising.github.io/fulcra/";
const sourceDirectory = fileURLToPath(new URL("../public/fulcra/", import.meta.url));
const entryFiles = [
  "index.html",
  "site.css",
  "site.js",
  "capture-policy.js",
  "captures.json",
  "assets/fulcra-mark.svg",
  "assets/social-preview.png",
];

export async function prepareSite({ source = sourceDirectory, output, preview = false }) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, "captures.json"), "utf8"));
  const frames = acceptedFrames(manifest);
  const complete =
    frames.length === manifest.frames?.length &&
    frames.length >= 2 &&
    ["mac-mini", "macbook-pro"].every((host) => frames.some((frame) => frame.capturedOn === host));
  if (!preview && !complete) {
    const error = new Error(
      "PUBLIC_CAPTURE_REQUIRED: reviewed, installed-identity-bound real captures from both Macs are required before publication.",
    );
    error.code = "PUBLIC_CAPTURE_REQUIRED";
    throw error;
  }
  const files = [...new Set([...entryFiles, ...frames.map((frame) => frame.src)])];
  const contents = new Map();
  for (const name of files) {
    const file = path.join(source, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error(`Not a regular public asset: ${name}`);
    const real = await fs.realpath(file);
    const root = await fs.realpath(source);
    if (!real.startsWith(root + path.sep))
      throw new Error(`Asset escapes the public site: ${name}`);
    const data = await fs.readFile(file);
    const frame = frames.find((item) => item.src === name);
    if (frame && createHash("sha256").update(data).digest("hex") !== frame.sha256)
      throw new Error(`Capture bytes differ from reviewed derivative: ${name}`);
    contents.set(name, data);
  }
  let html = contents.get("index.html").toString("utf8");
  html = html.replace(
    "<title>",
    `<link rel="canonical" href="${PUBLIC_URL}"><meta property="og:url" content="${PUBLIC_URL}">${preview ? '<meta name="robots" content="noindex">' : ""}<title>`,
  );
  html = html.replaceAll(
    'content="assets/social-preview.png"',
    `content="${PUBLIC_URL}assets/social-preview.png"`,
  );
  contents.set("index.html", Buffer.from(html));
  if (!output) return { publicUrl: PUBLIC_URL, preview, files, captures: frames.length };
  const destination = path.resolve(output);
  if (
    destination === path.resolve(source) ||
    destination.startsWith(path.resolve(source) + path.sep)
  )
    throw new Error("Output must be outside the public source directory.");
  // An existing directory is refused: no stale captures or unrelated public files
  // can survive an export, and this command never removes an owner's directory.
  await fs.mkdir(destination);
  for (const [name, data] of contents) {
    await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await fs.writeFile(path.join(destination, name), data, { flag: "wx" });
  }
  await fs.writeFile(path.join(destination, ".nojekyll"), "", { flag: "wx" });
  return { publicUrl: PUBLIC_URL, preview, files, captures: frames.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.some(
        (arg, index) => !["--preview", "--out"].includes(arg) && args[index - 1] !== "--out",
      )
    )
      throw new Error("Usage: prepare-fulcra-site.mjs [--preview] [--out <new-directory>]");
    const index = args.indexOf("--out");
    if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith("--")))
      throw new Error("--out requires a new directory.");
    console.log(
      JSON.stringify(
        await prepareSite({
          output: index >= 0 ? args[index + 1] : undefined,
          preview: args.includes("--preview"),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "PUBLIC_CAPTURE_REQUIRED" ? 42 : 1;
  }
}

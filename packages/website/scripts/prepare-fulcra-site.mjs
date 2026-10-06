import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_URL = "https://subrising.github.io/fulcra/";
const sourceDirectory = fileURLToPath(new URL("../public/fulcra/", import.meta.url));
const entryFiles = [
  "index.html",
  "site.css",
  "assets/fulcra-mark.svg",
  "assets/social-preview.png",
];
const shotsDirectory = "assets/shots";

// Copies only the public site files (never the social-preview source) and adds
// absolute canonical/share URLs for the GitHub Pages project URL.
export async function prepareSite({ source = sourceDirectory, output, preview = false }) {
  const shots = (await fs.readdir(path.join(source, shotsDirectory)))
    .filter((name) => /^[a-z0-9-]+(@2x)?\.(jpg|png)$/.test(name))
    .map((name) => `${shotsDirectory}/${name}`);
  const files = [...entryFiles, ...shots];
  const contents = new Map();
  for (const name of files) {
    const file = path.join(source, name);
    if (!(await fs.lstat(file)).isFile()) throw new Error(`Not a regular public asset: ${name}`);
    contents.set(name, await fs.readFile(file));
  }
  let html = contents.get("index.html").toString("utf8");
  for (const match of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g))
    if (!contents.has(match[1]))
      throw new Error(`index.html references a missing asset: ${match[1]}`);
  for (const match of html.matchAll(/(assets\/shots\/[^\s",]+)/g))
    if (!contents.has(match[1]))
      throw new Error(`index.html references a missing image: ${match[1]}`);
  html = html.replace(
    "<title>",
    `<link rel="canonical" href="${PUBLIC_URL}"><meta property="og:url" content="${PUBLIC_URL}">${preview ? '<meta name="robots" content="noindex">' : ""}<title>`,
  );
  html = html.replaceAll(
    'content="assets/social-preview.png"',
    `content="${PUBLIC_URL}assets/social-preview.png"`,
  );
  contents.set("index.html", Buffer.from(html));
  if (!output) return { publicUrl: PUBLIC_URL, preview, files };
  const destination = path.resolve(output);
  if (
    destination === path.resolve(source) ||
    destination.startsWith(path.resolve(source) + path.sep)
  )
    throw new Error("Output must be outside the public source directory.");
  // Refuse an existing directory so no stale files survive an export.
  await fs.mkdir(destination);
  for (const [name, data] of contents) {
    await fs.mkdir(path.dirname(path.join(destination, name)), { recursive: true });
    await fs.writeFile(path.join(destination, name), data, { flag: "wx" });
  }
  await fs.writeFile(path.join(destination, ".nojekyll"), "", { flag: "wx" });
  return { publicUrl: PUBLIC_URL, preview, files };
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
    const result = await prepareSite({
      output: index >= 0 ? args[index + 1] : undefined,
      preview: args.includes("--preview"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

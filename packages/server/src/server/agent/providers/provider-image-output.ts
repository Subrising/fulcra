import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentTimelineItem } from "../agent-sdk-types.js";

export interface ProviderImageOutput {
  path?: string | null;
  url?: string | null;
  data?: string | null;
  mimeType?: string | null;
  altText?: string | null;
}

export interface MaterializedProviderImage {
  path: string;
}

const materializedFacts = new WeakMap<object, { sha256: string; size: number }>();
export function materializedNativeImageFact(
  image: MaterializedProviderImage,
): { sha256: string; size: number } | undefined {
  const fact = materializedFacts.get(image);
  return fact ? { ...fact } : undefined;
}
const PROVIDER_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX = `${PROVIDER_IMAGE_ATTACHMENT_DIR}-`;
const PRIVATE_ATTACHMENT_DIR_MODE = 0o700;
const MATERIALIZED_IMAGE_FILE_MODE = 0o600;

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
// FULCRA(image-retention): retention is a rolling window. At the cap the least recently written images
// are deleted to make room, instead of refusing every new image for the rest of the daemon run.
export const MAX_PRIVATE_BYTES = 1024 * 1024 * 1024;
export const MAX_PRIVATE_FILES = 2000;
/** Shown for an image that was deleted to make room; other missing files keep their own error. */
export const EVICTED_PROVIDER_IMAGE_MESSAGE = "Image no longer kept";
// Names of images deleted to make room, oldest first; bounded so a long run cannot grow it forever.
const MAX_EVICTED_NAMES = 100_000;
const evictedNames = new Set<string>();
// Darwin's O_NOFOLLOW_ANY rejects symlinks in every path component, not just the leaf.
const noFollowAny = process.platform === "darwin" ? 0x20000000 : 0;
interface PrivateRoot {
  path: string;
  fd: number;
  dev: number;
  ino: number;
  files: Map<string, { dev: number; ino: number; size: number; mtimeMs: number }>;
  bytes: number;
  ancestors: Array<{ path: string; dev: number; ino: number }>;
}
let privateRoot: PrivateRoot | undefined;
function checkRoot(root: PrivateRoot): void {
  for (const ancestor of root.ancestors) {
    const current = fsSync.lstatSync(ancestor.path);
    if (!current.isDirectory() || current.dev !== ancestor.dev || current.ino !== ancestor.ino)
      throw new Error("Private image ancestor replaced");
  }

  const descriptor = fsSync.fstatSync(root.fd),
    observed = fsSync.lstatSync(root.path);
  if (
    !observed.isDirectory() ||
    observed.dev !== root.dev ||
    observed.ino !== root.ino ||
    descriptor.dev !== root.dev ||
    descriptor.ino !== root.ino ||
    (observed.mode & 0o777) !== 0o700 ||
    (process.geteuid && observed.uid !== process.geteuid())
  )
    throw new Error("Private image root replaced");
}
function getPrivateRoot(): PrivateRoot {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Confined image materialization unavailable");
  if (privateRoot) {
    try {
      checkRoot(privateRoot);
      return privateRoot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A missing pathname may be a still-live renamed directory. Never release its pool while
      // it may still hold images. Linux reports a removed directory with nlink 0. FULCRA(image-retention):
      // APFS reports nlink 2 + entries, so on macOS nlink 2 means the directory is empty (removed,
      // or renamed and empty): releasing its pool loses no image. Otherwise every later image
      // failed after macOS cleared its temporary folder.
      const retained = fsSync.fstatSync(privateRoot.fd);
      const released =
        retained.nlink === 0 || (process.platform === "darwin" && retained.nlink <= 2);
      if (retained.dev !== privateRoot.dev || retained.ino !== privateRoot.ino || !released)
        throw new Error("Private image root moved or deletion unproved", { cause: error });
      fsSync.closeSync(privateRoot.fd);
      privateRoot = undefined;
    }
  }
  const parent = fsSync.realpathSync(os.tmpdir());
  const dir = fsSync.mkdtempSync(path.join(parent, PROVIDER_IMAGE_ATTACHMENT_DIR_PREFIX));
  const created = fsSync.lstatSync(dir);
  const fd = fsSync.openSync(
    dir,
    fsSync.constants.O_RDONLY |
      fsSync.constants.O_DIRECTORY |
      (noFollowAny || fsSync.constants.O_NOFOLLOW),
  );
  const stat = fsSync.fstatSync(fd);
  if (stat.dev !== created.dev || stat.ino !== created.ino || !stat.isDirectory()) {
    fsSync.closeSync(fd);
    throw new Error("Private image creation replaced");
  }
  fsSync.fchmodSync(fd, PRIVATE_ATTACHMENT_DIR_MODE);
  const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
  for (let current = parent; ; current = path.dirname(current)) {
    const value = fsSync.lstatSync(current);
    ancestors.push({ path: current, dev: value.dev, ino: value.ino });
    if (path.dirname(current) === current) break;
  }
  const root = {
    path: dir,
    fd,
    dev: stat.dev,
    ino: stat.ino,
    files: new Map(),
    bytes: 0,
    ancestors,
  };
  checkRoot(root);
  privateRoot = root;
  return root;
}
function rememberEvicted(name: string): void {
  evictedNames.add(name);
  if (evictedNames.size > MAX_EVICTED_NAMES) {
    const oldest = evictedNames.values().next().value;
    if (oldest !== undefined) evictedNames.delete(oldest);
  }
}
// Deletes the least recently written image (Map order is write order). Only the exact inode this
// run wrote is removed; a replaced or missing one is just forgotten.
function evictOldest(root: PrivateRoot): void {
  const oldest = root.files.entries().next().value;
  if (!oldest) return;
  const [name, known] = oldest;
  const entryPath =
    process.platform === "linux" ? `/proc/self/fd/${root.fd}/${name}` : path.join(root.path, name);
  let current: fsSync.Stats | undefined;
  try {
    current = fsSync.lstatSync(entryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A replaced entry is never deleted (it is not the file this run wrote); it is only forgotten, so one
  // replaced file cannot stop every later image at the cap. Linux reuses a freed inode number at once,
  // so size and modification time must also match the file this run wrote.
  const ours =
    current?.isFile() &&
    current.dev === known.dev &&
    current.ino === known.ino &&
    current.size === known.size &&
    current.mtimeMs === known.mtimeMs;
  if (ours) fsSync.unlinkSync(entryPath);
  root.files.delete(name);
  root.bytes -= known.size;
  if (ours || !current) rememberEvicted(name);
}
/** True when `filePath` is a provider image this daemon run deleted to make room for newer ones. */
export function isEvictedProviderImage(filePath: string): boolean {
  if (!privateRoot || path.dirname(filePath) !== privateRoot.path) return false;
  return evictedNames.has(path.basename(filePath));
}
function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

function normalizeImageData(mimeType: string, data: string): { mimeType: string; data: string } {
  if (data.startsWith("data:")) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }
  return { mimeType, data };
}

function validateDestination(
  before: fsSync.Stats,
  created: boolean,
  known: { dev: number; ino: number; size: number; mtimeMs: number } | undefined,
): void {
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (process.geteuid && before.uid !== process.geteuid()) ||
    (!created &&
      (!known ||
        known.dev !== before.dev ||
        known.ino !== before.ino ||
        known.size !== before.size))
  )
    throw new Error("Private image destination refused");
}
function decodeBoundedImage(image: { data: string; mimeType: string | null }) {
  // Reject before allocating a root or opening any destination. Retention is separately bounded.
  if (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256)
    throw new Error("Native image exceeds byte limit");
  const normalized = normalizeImageData(image.mimeType ?? "image/png", image.data);
  const bytes = Buffer.from(normalized.data, "base64");
  if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Native image exceeds byte limit");
  return { normalized, bytes };
}
// Filenames are a content hash of the bytes so re-materializing the same image
// within a process reuses the existing temp file instead of leaking a fresh one
// for repeated image blocks or history replay.
export function materializeProviderImage(image: {
  data: string;
  mimeType: string | null;
}): MaterializedProviderImage {
  const { normalized, bytes } = decodeBoundedImage(image);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const name = `${hash}.${getImageExtension(normalized.mimeType)}`;
  const root = getPrivateRoot();
  checkRoot(root);
  const known = root.files.get(name);
  if (!known) {
    while (
      root.files.size > 0 &&
      (root.files.size >= MAX_PRIVATE_FILES || root.bytes + bytes.length > MAX_PRIVATE_BYTES)
    )
      evictOldest(root);
    evictedNames.delete(name);
  }
  const filePath = path.join(root.path, name);
  const openPath = process.platform === "linux" ? `/proc/self/fd/${root.fd}/${name}` : filePath;
  let descriptor: number,
    created = false;
  try {
    descriptor = fsSync.openSync(
      openPath,
      fsSync.constants.O_RDWR |
        fsSync.constants.O_CREAT |
        fsSync.constants.O_EXCL |
        (noFollowAny || fsSync.constants.O_NOFOLLOW),
      MATERIALIZED_IMAGE_FILE_MODE,
    );
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !known) throw error;
    descriptor = fsSync.openSync(
      openPath,
      fsSync.constants.O_RDONLY | (noFollowAny || fsSync.constants.O_NOFOLLOW),
    );
  }
  try {
    checkRoot(root);
    const before = fsSync.fstatSync(descriptor);
    validateDestination(before, created, known);
    // Exclusive new inode only. Reuse is read-only; never truncate/chmod an existing path.
    if (!known) {
      root.bytes += bytes.length;
      root.files.set(name, {
        dev: before.dev,
        ino: before.ino,
        size: bytes.length,
        mtimeMs: before.mtimeMs,
      });
    }
    if (created) fsSync.writeFileSync(descriptor, bytes);
    const after = fsSync.fstatSync(descriptor),
      observed = Buffer.alloc(bytes.length);
    fsSync.readSync(descriptor, observed, 0, observed.length, 0);
    checkRoot(root);
    if (
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== bytes.length ||
      !observed.equals(bytes)
    )
      throw new Error("Native image materialization changed");
    // Reuse moves the image to the newest end (Map order is the eviction order), so an image shown
    // again, for example on history replay, is not the next one deleted.
    root.files.delete(name);
    root.files.set(name, {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
    });
    const result = { path: filePath };
    materializedFacts.set(result, { sha256: hash, size: bytes.length });
    return result;
  } finally {
    fsSync.closeSync(descriptor);
  }
}

// Recognizes markdown rendered for a materialized provider image: its source is a content-hashed
// file in the attachments dir. Matching the full <hash>.<ext> shape (not just a leading "![")
// keeps user-authored text from being mistaken for a provider image during history replay. The
// separator still accepts old doubled-backslash Windows history; new Windows output uses file URIs.
const PROVIDER_IMAGE_MARKDOWN = new RegExp(
  `^!\\[[^\\]]*\\]\\([^)]*${PROVIDER_IMAGE_ATTACHMENT_DIR}(?:-[^/\\\\)]+)?[/\\\\]+(?:[^/\\\\)]+[/\\\\]+)?[0-9a-f]{64}\\.[a-z0-9]+\\)`,
);

export function isProviderImageMarkdown(text: string): boolean {
  return PROVIDER_IMAGE_MARKDOWN.test(text);
}

interface RenderProviderImageOutputOptions {
  materialize?: (image: { data: string; mimeType: string | null }) => MaterializedProviderImage;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isDataImageSource(source: string): boolean {
  return source.trim().toLowerCase().startsWith("data:image/");
}

function escapeMarkdownImageAlt(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function encodeFilePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function windowsFileUri(value: string): string | null {
  const isWindowsNetworkPath = value.startsWith("\\\\");
  let normalizedPath = value.replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(normalizedPath)) {
    normalizedPath = `//${normalizedPath.slice(8)}`;
  } else if (/^\/\/\?\/[A-Za-z]:\//.test(normalizedPath)) {
    normalizedPath = normalizedPath.slice(4);
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    const drive = normalizedPath.slice(0, 2);
    return `file:///${drive}${encodeFilePath(normalizedPath.slice(2))}`;
  }
  if (isWindowsNetworkPath && normalizedPath.startsWith("//")) {
    return `file:${encodeFilePath(normalizedPath)}`;
  }
  return null;
}

function markdownImageSource(value: string): string {
  const windowsUri = windowsFileUri(value);
  if (windowsUri) {
    return windowsUri;
  }
  if (value.startsWith("/")) {
    return `file://${encodeFilePath(value)}`;
  }
  return value;
}

function escapeMarkdownImageSource(value: string): string {
  return markdownImageSource(value).replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export function renderProviderImageOutputAsAssistantMarkdown(
  image: ProviderImageOutput,
  options: RenderProviderImageOutputOptions = {},
): AgentTimelineItem | null {
  const source = nonEmptyString(image.path) ?? nonEmptyString(image.url);
  if (source && !isDataImageSource(source)) {
    const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
    return {
      type: "assistant_message",
      text: `![${altText}](${escapeMarkdownImageSource(source)})`,
    };
  }

  const data = nonEmptyString(image.data) ?? (source && isDataImageSource(source) ? source : null);
  if (!data) {
    return null;
  }

  let materialized: MaterializedProviderImage | null = null;
  try {
    materialized = options.materialize
      ? options.materialize({
          data,
          mimeType: nonEmptyString(image.mimeType),
        })
      : null;
  } catch {
    materialized = null;
  }
  if (!materialized?.path || isDataImageSource(materialized.path)) {
    return {
      type: "assistant_message",
      text: "Image output was omitted because it was not available as a file path or URL.",
    };
  }

  const altText = escapeMarkdownImageAlt(nonEmptyString(image.altText) ?? "Image");
  return {
    type: "assistant_message",
    text: `![${altText}](${escapeMarkdownImageSource(materialized.path)})`,
  };
}

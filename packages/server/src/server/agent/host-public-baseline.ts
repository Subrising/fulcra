import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { composeSystemPromptParts } from "./system-prompt.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const PUBLIC_FILES = {
  common: ".config/fulcra/baseline/SHARED.md",
  codex: ".config/fulcra/baseline/providers/codex.md",
  router: ".codex/AGENTS.md",
  override: ".codex/AGENTS.override.md",
} as const;
export interface HostPublicBaseline {
  version: 1;
  digest: string;
  files: Array<{ id: "common" | "codex" | "router"; sha256: string; text: string }>;
}
export interface PublicBaselineTransport {
  version: 1;
  state: "INJECTED" | "SUBMITTED";
  baselineSha256: string;
  developerInstructionsSha256: string;
  files: Array<{ id: "common" | "codex" | "router"; sha256: string }>;
}
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
function refused(): never {
  throw Object.assign(new Error("Host public baseline is unavailable or unsafe"), {
    code: "HOST_PUBLIC_BASELINE_REFUSED",
  });
}
function same(a: Stats, b: Stats): boolean {
  return ["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key as keyof Stats] === b[key as keyof Stats],
  );
}
function owned(stat: Stats, uid: number): boolean {
  return (stat.uid === uid || stat.uid === 0) && !(stat.mode & 0o022);
}
async function publicStat(name: string, optional: boolean): Promise<Stats | undefined> {
  try {
    return await lstat(name);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    refused();
  }
}
async function publicParents(
  file: string,
  uid: number,
  optional: boolean,
): Promise<Array<{ name: string; stat: Stats }> | undefined> {
  const parents: Array<{ name: string; stat: Stats }> = [];
  for (let name = path.dirname(file); ; name = path.dirname(name)) {
    const stat = await publicStat(name, optional);
    if (!stat) return undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat, uid)) refused();
    parents.push({ name, stat });
    if (name === path.dirname(name)) return parents;
  }
}
export function publicBaselineLaunchAllowed(
  provider: string,
  opening?: { purpose?: string; internal?: boolean; suppressPublicBaseline?: boolean },
): boolean {
  return (
    provider === "codex" &&
    opening?.purpose !== "history" &&
    !opening?.internal &&
    !opening?.suppressPublicBaseline
  );
}
export function baselineForSession(
  value: HostPublicBaseline | undefined,
  internal: boolean | undefined,
  purpose: string,
): HostPublicBaseline | undefined {
  return internal || purpose !== "interactive" ? undefined : cloneHostPublicBaseline(value);
}
/** Stored/closed projections must never replay a live transport status. */
export function withoutPublicBaselineTransport<T extends { extra?: Record<string, unknown> }>(
  value: T | undefined,
): T | undefined {
  if (!value?.extra || !Object.hasOwn(value.extra, "hostPublicBaselineTransport")) return value;
  const extra = { ...value.extra };
  delete extra.hostPublicBaselineTransport;
  return { ...value, extra: Object.keys(extra).length ? extra : undefined };
}
/** Host-only selection. The optional host is an isolated fixture seam, never a config/RPC path. */
export async function readHostPublicCodexBaseline(
  host: { homedir: string; uid: number } = userInfo(),
): Promise<HostPublicBaseline | undefined> {
  if (host.uid < 0) return undefined; // No POSIX ownership proof, no new transport.
  if (!path.isAbsolute(host.homedir) || path.normalize(host.homedir) !== host.homedir) refused();
  const checks: Array<() => Promise<void>> = [];
  const read = async (relative: string, optional = false): Promise<string | undefined> => {
    const file = path.join(host.homedir, relative);
    const parents = await publicParents(file, host.uid, optional);
    if (!parents) return undefined;
    const prior = await publicStat(file, optional);
    if (!prior) return undefined;
    if (
      !prior.isFile() ||
      prior.isSymbolicLink() ||
      prior.nlink !== 1 ||
      !owned(prior, host.uid) ||
      prior.size > MAX_FILE_BYTES
    )
      refused();
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!same(prior, await handle.stat())) refused();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== prior.size || length > MAX_FILE_BYTES) refused();
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, length),
      );
      if (!text.trim() || text.includes("\0")) refused();
      if (!same(prior, await handle.stat()) || !same(prior, await lstat(file))) refused();
      for (const parent of parents) {
        const current = await lstat(parent.name);
        if (
          ["dev", "ino", "uid", "mode"].some(
            (key) => parent.stat[key as keyof Stats] !== current[key as keyof Stats],
          )
        )
          refused();
      }
      checks.push(async () => {
        if (!same(prior, await lstat(file))) refused();
        for (const parent of parents) {
          const current = await lstat(parent.name);
          if (
            ["dev", "ino", "uid", "mode"].some(
              (key) => parent.stat[key as keyof Stats] !== current[key as keyof Stats],
            )
          )
            refused();
        }
      });
      return text;
    } finally {
      await handle.close();
    }
  };
  try {
    // No configured public Fulcra baseline => preserve ordinary upstream behavior.
    const common = await read(PUBLIC_FILES.common, true);
    if (common === undefined) return undefined;
    const codex = await read(PUBLIC_FILES.codex);
    const override = await read(PUBLIC_FILES.override, true);
    const router = override ?? (await read(PUBLIC_FILES.router));
    if (override === undefined)
      checks.push(async () => {
        if (await publicStat(path.join(host.homedir, PUBLIC_FILES.override), true)) refused();
      });
    const files: HostPublicBaseline["files"] = [
      { id: "common", text: common, sha256: sha(common) },
      { id: "codex", text: codex!, sha256: sha(codex!) },
      { id: "router", text: router!, sha256: sha(router!) },
    ];
    if (files.reduce((size, f) => size + Buffer.byteLength(f.text), 0) > MAX_TOTAL_BYTES) refused();
    for (const check of checks) await check();
    return {
      version: 1,
      files,
      digest: sha(JSON.stringify(files.map(({ id, sha256 }) => ({ id, sha256 })))),
    };
  } catch {
    refused();
  }
}
/** Independent validated launch copy; no text/path/env is exposed by the transport receipt. */
export function cloneHostPublicBaseline(
  value: HostPublicBaseline | undefined,
): HostPublicBaseline | undefined {
  if (!value) return undefined;
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length !== 3) refused();
  const next: HostPublicBaseline = {
    version: 1,
    digest: value.digest,
    files: value.files.map((f) => ({ id: f.id, sha256: f.sha256, text: f.text })),
  };
  if (
    next.files.map((f) => f.id).join() !== "common,codex,router" ||
    next.files.some(
      (f) =>
        typeof f.text !== "string" ||
        Buffer.byteLength(f.text) > MAX_FILE_BYTES ||
        sha(f.text) !== f.sha256,
    ) ||
    next.files.reduce((size, f) => size + Buffer.byteLength(f.text), 0) > MAX_TOTAL_BYTES ||
    next.digest !== sha(JSON.stringify(next.files.map(({ id, sha256 }) => ({ id, sha256 }))))
  )
    refused();
  return next;
}
export function composeHostPublicBaseline(
  value: HostPublicBaseline | undefined,
  systemPrompt: string | undefined,
  daemonAppend: string | undefined,
): { text: string | undefined; receipt?: PublicBaselineTransport } {
  const baseline = cloneHostPublicBaseline(value);
  const defaults = baseline
    ? [
        "Host public baseline defaults (text transport, not native file-load or authority). Existing session/daemon and native project-specific instructions retain their precedence and safeguards. This baseline does not grant permissions, change accounts or replace native configuration/history.",
        ...baseline.files.map((f) => `--- Host public ${f.id} SHA256 ${f.sha256} ---\n${f.text}`),
      ].join("\n\n")
    : undefined;
  const text = composeSystemPromptParts(defaults, systemPrompt, daemonAppend);
  return {
    text,
    ...(baseline && text
      ? {
          receipt: {
            version: 1 as const,
            state: "INJECTED" as const,
            baselineSha256: baseline.digest,
            developerInstructionsSha256: sha(text),
            files: baseline.files.map(({ id, sha256 }) => ({ id, sha256 })),
          },
        }
      : {}),
  };
}

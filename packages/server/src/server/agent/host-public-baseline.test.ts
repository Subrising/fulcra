import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  linkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readHostPublicCodexBaseline,
  cloneHostPublicBaseline,
  composeHostPublicBaseline,
  baselineForSession,
  withoutPublicBaselineTransport,
} from "./host-public-baseline.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function host() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "public-baseline-"));
  roots.push(root);
  mkdirSync(path.join(root, ".config/fulcra/baseline/providers"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, ".codex"), { mode: 0o700 });
  return { homedir: root, uid: process.getuid!() };
}
function write(root: string, relative: string, text: string | Buffer) {
  writeFileSync(path.join(root, relative), text, { mode: 0o600 });
}
function populate() {
  const h = host();
  write(h.homedir, ".config/fulcra/baseline/SHARED.md", "COMMON\n");
  write(h.homedir, ".config/fulcra/baseline/providers/codex.md", "CODEX\n");
  write(h.homedir, ".codex/AGENTS.md", "ROUTER\n");
  return h;
}
test("fixed public common/provider/router bytes bind hashes; override selection and independent launch clones", async () => {
  const h = populate();
  let value = await readHostPublicCodexBaseline(h);
  expect(value?.files.map((f) => f.text)).toEqual(["COMMON\n", "CODEX\n", "ROUTER\n"]);
  const one = cloneHostPublicBaseline(value)!,
    two = cloneHostPublicBaseline(value)!;
  one.files[0].text = "MUTATED";
  expect(two.files[0].text).toBe("COMMON\n");
  expect(value?.files[0].text).toBe("COMMON\n");
  write(h.homedir, ".codex/AGENTS.override.md", "OVERRIDE\n");
  value = await readHostPublicCodexBaseline(h);
  expect(value?.files[2].text).toBe("OVERRIDE\n");
  expect(value?.files[2].sha256).toBe(createHash("sha256").update("OVERRIDE\n").digest("hex"));
  expect(value).not.toHaveProperty("home");
});
test("unconfigured host keeps upstream behavior; configured incomplete public baseline refuses", async () => {
  const h = host();
  expect(await readHostPublicCodexBaseline(h)).toBeUndefined();
  write(h.homedir, ".config/fulcra/baseline/SHARED.md", "COMMON");
  await expect(readHostPublicCodexBaseline(h)).rejects.toMatchObject({
    code: "HOST_PUBLIC_BASELINE_REFUSED",
  });
});
test.each([
  "symlink-file",
  "symlink-parent",
  "hardlink",
  "writable",
  "oversize",
  "invalid-utf8",
  "nul",
  "empty",
  "wrong-owner",
  "alias-home",
])("%s refuses rather than reading a private/caller alias", async (kind) => {
  const h = populate(),
    file = path.join(h.homedir, ".codex/AGENTS.md");
  if (kind === "symlink-file") {
    rmSync(file);
    symlinkSync(path.join(h.homedir, ".config/fulcra/baseline/SHARED.md"), file);
  }
  if (kind === "symlink-parent") {
    rmSync(path.join(h.homedir, ".codex"), { recursive: true });
    symlinkSync(path.join(h.homedir, ".config/fulcra/baseline"), path.join(h.homedir, ".codex"));
  }
  if (kind === "hardlink") {
    rmSync(file);
    linkSync(path.join(h.homedir, ".config/fulcra/baseline/SHARED.md"), file);
  }
  if (kind === "writable") chmodSync(file, 0o666);
  if (kind === "oversize") writeFileSync(file, "x".repeat(65537));
  if (kind === "invalid-utf8") writeFileSync(file, Buffer.from([0xff]));
  if (kind === "nul") writeFileSync(file, "not\0text");
  if (kind === "empty") writeFileSync(file, " ");
  if (kind === "wrong-owner") h.uid = h.uid + 10000;
  if (kind === "alias-home") {
    const alias = h.homedir + "-alias";
    roots.push(alias);
    symlinkSync(h.homedir, alias);
    h.homedir = alias;
  }
  await expect(readHostPublicCodexBaseline(h)).rejects.toMatchObject({
    code: "HOST_PUBLIC_BASELINE_REFUSED",
  });
});
test("exact default-first composition preserves original instruction suffix/order; readback is digest-only and not consumed", async () => {
  const value = await readHostPublicCodexBaseline(populate());
  const result = composeHostPublicBaseline(value, "SESSION", "DAEMON");
  expect(result.text?.endsWith("\n\nSESSION\n\nDAEMON")).toBe(true);
  expect(result.text).toContain("COMMON\n");
  expect(result.text).toContain("CODEX\n");
  expect(result.text).toContain("ROUTER\n");
  expect(result.receipt).toMatchObject({
    state: "INJECTED",
    baselineSha256: value?.digest,
    developerInstructionsSha256: createHash("sha256").update(result.text!).digest("hex"),
  });
  const encoded = JSON.stringify(result.receipt);
  for (const text of ["COMMON", "CODEX", "ROUTER", "SESSION", "DAEMON", value?.files[0].text])
    expect(encoded).not.toContain(text!);
  expect(baselineForSession(value, true, "interactive")).toBeUndefined();
  expect(baselineForSession(value, false, "history")).toBeUndefined();
  expect(composeHostPublicBaseline(undefined, "SESSION", "DAEMON")).toEqual({
    text: "SESSION\n\nDAEMON",
  });
  const info = { extra: { existing: "preserved", hostPublicBaselineTransport: result.receipt } };
  expect(withoutPublicBaselineTransport(info)).toEqual({ extra: { existing: "preserved" } });
  expect(info.extra.hostPublicBaselineTransport).toBe(result.receipt);
});
test("mutated launch text cannot retain old matching hashes", async () => {
  const value = (await readHostPublicCodexBaseline(populate()))!;
  value.files[0].text = "mutated";
  expect(() => cloneHostPublicBaseline(value)).toThrow("Host public baseline");
});

test("aggregate budget refuses an otherwise valid public set", async () => {
  const h = populate();
  for (const name of [
    ".config/fulcra/baseline/SHARED.md",
    ".config/fulcra/baseline/providers/codex.md",
    ".codex/AGENTS.md",
  ])
    write(h.homedir, name, "x".repeat(65536));
  await expect(readHostPublicCodexBaseline(h)).rejects.toMatchObject({
    code: "HOST_PUBLIC_BASELINE_REFUSED",
  });
});
test("set-wide final binding refuses a public file changed after its individual read", async () => {
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)(
    "node:fs/promises",
  ) as typeof import("node:fs/promises");
  const { vi } = await import("vitest");
  const h = populate(),
    original = fs.lstat;
  let changed = false;
  const spy = vi.spyOn(fs, "lstat").mockImplementation(async (name) => {
    const result = await original(name);
    if (
      String(name) === path.join(h.homedir, ".config/fulcra/baseline/providers/codex.md") &&
      !changed
    ) {
      changed = true;
      write(h.homedir, ".config/fulcra/baseline/SHARED.md", "CHANGED COMMON");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    await expect(readHostPublicCodexBaseline(h)).rejects.toMatchObject({
      code: "HOST_PUBLIC_BASELINE_REFUSED",
    });
    expect(changed).toBe(true);
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
});

test("a selected unsafe override refuses instead of falling back to another public router", async () => {
  const h = populate();
  write(h.homedir, ".codex/AGENTS.override.md", "OVERRIDE");
  chmodSync(path.join(h.homedir, ".codex/AGENTS.override.md"), 0o666);
  await expect(readHostPublicCodexBaseline(h)).rejects.toMatchObject({
    code: "HOST_PUBLIC_BASELINE_REFUSED",
  });
});

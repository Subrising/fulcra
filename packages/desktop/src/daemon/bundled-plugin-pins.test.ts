import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readBundledPluginPins } from "./bundled-plugin-pins";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bundled-pins-"));
  roots.push(root);
  mkdirSync(path.join(root, "example"));
  writeFileSync(path.join(root, "example/paseo-plugin.json"), JSON.stringify({ id: "example" }));
  const hash = createHash("sha256").update("fixture compiled client").digest("hex");
  writeFileSync(
    path.join(root, "example/runtime-manifest.json"),
    JSON.stringify({ version: 1, client: hash }),
  );
  return { root, hash };
}
it("reads only the app's build-generated SHA-256 pins", () => {
  const { root, hash } = fixture();
  expect(readBundledPluginPins(root)).toEqual({ example: hash });
});
it("fails closed on malformed or over-limit manifests", () => {
  const { root } = fixture();
  writeFileSync(
    path.join(root, "example/runtime-manifest.json"),
    JSON.stringify({ version: 1, client: "untrusted" }),
  );
  expect(readBundledPluginPins(root)).toEqual({});
  writeFileSync(path.join(root, "example/runtime-manifest.json"), " ".repeat(65537));
  expect(readBundledPluginPins(root)).toEqual({});
});
it("does not follow a manifest symlink to another host's files", () => {
  const { root } = fixture();
  const other = fixture();
  rmSync(path.join(root, "example/runtime-manifest.json"));
  symlinkSync(
    path.join(other.root, "example/runtime-manifest.json"),
    path.join(root, "example/runtime-manifest.json"),
  );
  expect(readBundledPluginPins(root)).toEqual({});
});

it("m3 skips and logs one malformed directory without losing a valid pin", () => {
  const { root, hash } = fixture();
  mkdirSync(path.join(root, "broken"));
  const warn = vi.fn();
  expect(readBundledPluginPins(root, warn)).toEqual({ example: hash });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken"));
});
it("m2 rejects duplicate plugin IDs globally", () => {
  const { root, hash } = fixture();
  mkdirSync(path.join(root, "duplicate"));
  writeFileSync(path.join(root, "duplicate/paseo-plugin.json"), JSON.stringify({ id: "example" }));
  writeFileSync(
    path.join(root, "duplicate/runtime-manifest.json"),
    JSON.stringify({ version: 1, client: hash }),
  );
  expect(readBundledPluginPins(root)).toEqual({});
});
it("m2 refuses more than 128 roots", () => {
  const { root } = fixture();
  for (let i = 0; i < 128; i++) mkdirSync(path.join(root, "extra-" + i));
  expect(readBundledPluginPins(root)).toEqual({});
});

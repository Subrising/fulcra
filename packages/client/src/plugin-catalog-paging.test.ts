import { createHash } from "node:crypto";
import { fromByteArray } from "base64-js";
import { expect, test, vi } from "vitest";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { readPagedPluginCatalog, type CatalogPagingReader } from "./plugin-catalog-paging";
import type { PluginCatalogPageResponse } from "@getpaseo/protocol/plugin-catalog-paging";

const id = "00000000-0000-4000-8000-000000000001";
const revision = "00000000-0000-4000-8000-000000000002";
const hash = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Page = Extract<PluginCatalogPageResponse["payload"], { status: "ok" }>;
async function fixture(script = "α😀export default {};") {
  const bytes = new TextEncoder().encode(script);
  const trust = { trustedHost: { contract: "1.1" as const, boot: "boot" }, trustedPlugins: [] };
  const entry = {
    id: "example",
    bundle: { reference: id, sha256: await hash(bytes), byteLength: bytes.byteLength },
  };
  const manifestHash = await hash(
    new TextEncoder().encode(canonicalJson({ version: 1, revision, entries: [entry], trust })),
  );
  const page: Page = {
    requestId: "page",
    status: "ok",
    version: 1,
    snapshotId: id,
    revision,
    manifestHash,
    expiresAt: Date.now() + 20000,
    entries: [entry],
    nextCursor: null,
    trust,
  };
  let current = true;
  const reader: CatalogPagingReader = {
    assertCurrent: () => {
      if (!current) throw new Error("cancelled");
    },
    sha256: hash,
    page: vi.fn(async () => page),
    chunk: vi.fn(async (_snapshot, reference, offset, length) => {
      const data = bytes.slice(offset, offset + Math.min(length, 2));
      return {
        requestId: "chunk",
        status: "ok",
        version: 1,
        snapshotId: id,
        revision,
        manifestHash,
        expiresAt: page.expiresAt,
        reference,
        sha256: entry.bundle.sha256,
        offset,
        totalBytes: bytes.byteLength,
        data: fromByteArray(data),
        eof: offset + data.byteLength === bytes.byteLength,
      };
    }),
    release: vi.fn(async () => {}),
  };
  return {
    reader,
    page,
    bytes,
    revoke: () => {
      current = false;
    },
  };
}

test("paged catalog hashes all bytes before decoding split UTF8 and releases the exact snapshot", async () => {
  const { reader } = await fixture();
  const output = await readPagedPluginCatalog(reader);
  expect(output.plugins[0]?.clientBundle).toBe("α😀export default {};");
  expect(reader.chunk).toHaveBeenCalled();
  expect(reader.release).toHaveBeenCalledExactlyOnceWith(id);
});
test("manifest corruption refuses before any bundle read", async () => {
  const { reader, page } = await fixture();
  page.manifestHash = "a".repeat(64);
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("manifest mismatch");
  expect(reader.chunk).not.toHaveBeenCalled();
  expect(reader.release).toHaveBeenCalledOnce();
});
test("bundle corruption never exposes partial scripts", async () => {
  const { reader } = await fixture();
  const chunk = reader.chunk;
  reader.chunk = async (...args) => {
    const value = await chunk(...args);
    return value.status === "ok"
      ? { ...value, data: fromByteArray(new Uint8Array([1, 2])) }
      : value;
  };
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow();
  expect(reader.release).toHaveBeenCalledOnce();
});
test("held crypto cancellation discards an otherwise valid manifest without reading bundles", async () => {
  const { reader, revoke } = await fixture();
  const digest = reader.sha256;
  reader.sha256 = async (bytes) => {
    const result = await digest(bytes);
    revoke();
    return result;
  };
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("cancelled");
  expect(reader.chunk).not.toHaveBeenCalled();
});
test("expired pages refuse without bundle reads", async () => {
  const { reader, page } = await fixture();
  page.expiresAt = Date.now() - 1;
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("expired");
  expect(reader.chunk).not.toHaveBeenCalled();
});
test("foreign snapshot in a later chunk refuses and does not retarget", async () => {
  const { reader } = await fixture();
  const chunk = reader.chunk;
  reader.chunk = vi.fn(async (...args) => {
    const value = await chunk(...args);
    return value.status === "ok" ? { ...value, snapshotId: revision } : value;
  });
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("snapshot changed");
  expect(reader.chunk).toHaveBeenCalledTimes(1);
});
test("host refusal is preserved with no alternative request or repeated first page", async () => {
  const { reader } = await fixture();
  reader.page = vi.fn(async () => ({
    requestId: "page",
    status: "refused",
    error: "read_revoked",
  }));
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("read_revoked");
  expect(reader.page).toHaveBeenCalledOnce();
  expect(reader.chunk).not.toHaveBeenCalled();
});
test("repeated cursor or duplicate entry refuses before scripts", async () => {
  const { reader, page } = await fixture();
  page.nextCursor = revision;
  await expect(readPagedPluginCatalog(reader)).rejects.toThrow("Duplicate");
  expect(reader.chunk).not.toHaveBeenCalled();
});

import { fromByteArray, toByteArray } from "base64-js";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import {
  PLUGIN_CATALOG_CHUNK_BYTES,
  PLUGIN_CATALOG_SNAPSHOT_TTL_MS,
  PluginCatalogPageResponseSchema,
  PluginCatalogBundleGetResponseSchema,
  type PluginCatalogDescriptor,
  type PluginCatalogPageResponse,
  type PluginCatalogBundleGetResponse,
} from "@getpaseo/protocol/plugin-catalog-paging";

type Page = Extract<PluginCatalogPageResponse["payload"], { status: "ok" }>;
export interface CatalogPagingReader {
  assertCurrent(): void;
  page(cursor?: string): Promise<PluginCatalogPageResponse["payload"]>;
  chunk(
    snapshotId: string,
    reference: string,
    offset: number,
    length: number,
  ): Promise<PluginCatalogBundleGetResponse["payload"]>;
  release(snapshotId: string): Promise<void>;
  /** Trusted local runtime crypto, never a host-provided digest implementation. */
  sha256(bytes: Uint8Array): Promise<string>;
}

/** Fetches inert bytes. Bundle evaluation and independent bundled-plugin pin checks stay downstream. */
export async function readPagedPluginCatalog(reader: CatalogPagingReader) {
  const encoder = new TextEncoder();
  let snapshot: Page | undefined;
  let operations = 0;
  const charge = () => {
    if (++operations > 1024) throw new Error("Plugin catalog read refused: resource_limit");
  };
  const check = () => {
    reader.assertCurrent();
    if (
      snapshot &&
      (snapshot.expiresAt <= Date.now() ||
        snapshot.expiresAt > Date.now() + PLUGIN_CATALOG_SNAPSHOT_TTL_MS)
    )
      throw new Error("Plugin catalog read refused: expired");
  };
  const entries: PluginCatalogDescriptor[] = [];
  const cursors = new Set<string>();
  let metadataBytes = 0;
  const sameSnapshot = (value: {
    snapshotId: string;
    revision: string;
    manifestHash: string;
    expiresAt: number;
  }) => {
    if (
      !snapshot ||
      value.snapshotId !== snapshot.snapshotId ||
      value.revision !== snapshot.revision ||
      value.manifestHash !== snapshot.manifestHash ||
      value.expiresAt !== snapshot.expiresAt
    )
      throw new Error("Plugin catalog snapshot changed");
  };
  const readEntries = async () => {
    let cursor: string | undefined;
    do {
      check();
      charge();
      const page = PluginCatalogPageResponseSchema.shape.payload.parse(await reader.page(cursor));
      check();
      if (page.status === "refused") throw new Error(`Plugin catalog read refused: ${page.error}`);
      if (!snapshot) snapshot = page;
      sameSnapshot(page);
      check();
      if (canonicalJson(page.trust) !== canonicalJson(snapshot.trust))
        throw new Error("Plugin catalog trust changed");
      metadataBytes += encoder.encode(JSON.stringify(page.entries)).byteLength;
      if (entries.length + page.entries.length > 128 || metadataBytes > 256 * 1024)
        throw new Error("Plugin catalog read refused: resource_limit");
      for (const entry of page.entries) {
        if (
          entries.some(
            (previous) =>
              previous.id === entry.id || previous.bundle.reference === entry.bundle.reference,
          )
        )
          throw new Error("Duplicate plugin catalog entry");
        entries.push(entry);
      }
      if (page.nextCursor && (cursors.has(page.nextCursor) || page.entries.length === 0))
        throw new Error("Plugin catalog cursor repeated");
      if (page.nextCursor) cursors.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  };
  try {
    await readEntries();
    if (!snapshot) throw new Error("Plugin catalog unavailable");
    const manifest = encoder.encode(
      canonicalJson({ version: 1, revision: snapshot.revision, entries, trust: snapshot.trust }),
    );
    if (
      manifest.byteLength > 256 * 1024 ||
      (await reader.sha256(manifest)) !== snapshot.manifestHash
    )
      throw new Error("Plugin catalog manifest mismatch");
    check();
    let sourceBytes = 0;
    const plugins: Array<{
      id: string;
      clientBundle: string;
      requirements?: PluginCatalogDescriptor["requirements"];
    }> = [];
    const admittedSnapshot = snapshot;
    const readBundle = async (entry: PluginCatalogDescriptor) => {
      sourceBytes += entry.bundle.byteLength;
      if (sourceBytes > 8 * 1024 * 1024)
        throw new Error("Plugin catalog read refused: resource_limit");
      const bytes = new Uint8Array(entry.bundle.byteLength);
      let offset = 0;
      do {
        check();
        const requested = Math.min(
          PLUGIN_CATALOG_CHUNK_BYTES,
          Math.max(1, bytes.byteLength - offset),
        );
        charge();
        const chunk = PluginCatalogBundleGetResponseSchema.shape.payload.parse(
          await reader.chunk(
            admittedSnapshot.snapshotId,
            entry.bundle.reference,
            offset,
            requested,
          ),
        );
        check();
        if (chunk.status === "refused")
          throw new Error(`Plugin catalog read refused: ${chunk.error}`);
        sameSnapshot(chunk);
        if (
          chunk.reference !== entry.bundle.reference ||
          chunk.sha256 !== entry.bundle.sha256 ||
          chunk.totalBytes !== bytes.byteLength ||
          chunk.offset !== offset
        )
          throw new Error("Plugin catalog chunk mismatch");
        const data = toByteArray(chunk.data);
        if (
          fromByteArray(data) !== chunk.data ||
          data.byteLength > requested ||
          offset + data.byteLength > bytes.byteLength ||
          chunk.eof !== (offset + data.byteLength === bytes.byteLength) ||
          (!chunk.eof && data.byteLength === 0)
        )
          throw new Error("Plugin catalog chunk boundary mismatch");
        bytes.set(data, offset);
        offset += data.byteLength;
        if (chunk.eof) break;
      } while (offset < bytes.byteLength);
      if ((await reader.sha256(bytes)) !== entry.bundle.sha256)
        throw new Error("Plugin catalog bundle hash mismatch");
      check();
      const clientBundle = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // Match the existing full-entry encoded cap, not just its unescaped script bytes.
      const plugin = {
        id: entry.id,
        clientBundle,
        ...(entry.requirements ? { requirements: entry.requirements } : {}),
      };
      if (encoder.encode(JSON.stringify(plugin)).byteLength > 1024 * 1024)
        throw new Error("Plugin catalog read refused: resource_limit");
      return plugin;
    };
    for (const entry of entries) plugins.push(await readBundle(entry));
    const catalog = { plugins, ...snapshot.trust };
    if (encoder.encode(JSON.stringify(catalog)).byteLength > 8 * 1024 * 1024)
      throw new Error("Plugin catalog read refused: resource_limit");
    check();
    return catalog;
  } finally {
    if (snapshot) {
      try {
        await reader.release(snapshot.snapshotId);
      } catch {
        /* No cleanup retry or legacy fallback. */
      }
    }
  }
}

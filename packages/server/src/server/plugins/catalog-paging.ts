import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { CONTROLLER_SERVICE_MAX_BYTES } from "@getpaseo/protocol/controller-service";
import {
  PLUGIN_CATALOG_PAGE_BYTES,
  PLUGIN_CATALOG_REPLY_BYTES,
  PLUGIN_CATALOG_SNAPSHOT_TTL_MS,
  PluginCatalogDescriptorSchema,
  PluginCatalogTrustSchema,
  type PluginCatalogDescriptor,
  type PluginCatalogTrust,
  type PluginCatalogReadError,
  type PluginCatalogPageResponse,
  type PluginCatalogBundleGetResponse,
} from "@getpaseo/protocol/plugin-catalog-paging";
import type { PluginRequirements } from "@getpaseo/protocol/messages";

export interface CatalogReadState {
  revision: string;
  entries: Array<{ id: string; clientBundle: string; requirements?: PluginRequirements }>;
}
export class CatalogReadRefusal extends Error {
  constructor(readonly code: PluginCatalogReadError) {
    super(`Plugin catalog read refused: ${code}`);
  }
}
type Guard = () => void;
type Page = Extract<PluginCatalogPageResponse["payload"], { status: "ok" }>;
type Chunk = Extract<PluginCatalogBundleGetResponse["payload"], { status: "ok" }>;
interface Snapshot {
  id: string;
  revision: string;
  manifestHash: string;
  createdAt: number;
  expiresAt: number;
  reader: object;
  guard: Guard;
  close: () => void;
  trust: PluginCatalogTrust;
  entries: PluginCatalogDescriptor[];
  pages: PluginCatalogDescriptor[][];
  cursors: string[];
  operations: number;
  readBytes: number;
  retainedBytes: number;
  timer?: ReturnType<typeof setTimeout>;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function check(guard: Guard): void {
  try {
    if (guard() !== undefined) throw new CatalogReadRefusal("read_revoked");
  } catch {
    throw new CatalogReadRefusal("read_revoked");
  }
}

/** Host-global, metadata-only references. Readers and guards come from the admitted Session, never wire. */
export class PluginCatalogPaging {
  private readonly snapshots = new Map<string, Snapshot>();
  private operations: number[] = [];
  private observedAt = 0;
  private retainedBytes = 0;
  constructor(
    private readonly readState: () => CatalogReadState | Promise<CatalogReadState>,
    private readonly currentRevision: () => string,
    private readonly clock: () => number = Date.now,
  ) {}

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < this.observedAt)
      throw new CatalogReadRefusal("expired");
    this.observedAt = now;
    for (const snapshot of this.snapshots.values())
      if (snapshot.expiresAt <= now) this.drop(snapshot);
    return now;
  }
  private charge(guard: Guard): number {
    check(guard);
    const now = this.now();
    this.operations = this.operations.filter((at) => at > now - 60_000);
    if (this.operations.length >= 1024) throw new CatalogReadRefusal("resource_limit");
    this.operations.push(now); // Failed reads consume bounded throughput too; no internal retry.
    return now;
  }
  private require(snapshot: Snapshot, reader: object, guard: Guard): void {
    check(guard);
    if (snapshot.reader !== reader) throw new CatalogReadRefusal("read_revoked");
    check(snapshot.guard);
    const now = this.now();
    if (!this.snapshots.has(snapshot.id) || now >= snapshot.expiresAt)
      throw new CatalogReadRefusal("expired");
    if (this.currentRevision() !== snapshot.revision) {
      this.drop(snapshot);
      throw new CatalogReadRefusal("stale_snapshot");
    }
  }
  private lookup(id: string, reader: object, guard: Guard): Snapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new CatalogReadRefusal("unavailable");
    this.require(snapshot, reader, guard);
    return snapshot;
  }
  private drop(snapshot: Snapshot): void {
    if (!this.snapshots.delete(snapshot.id)) return;
    this.retainedBytes -= snapshot.retainedBytes;
    if (snapshot.timer) clearTimeout(snapshot.timer);
    try {
      snapshot.close();
    } catch {
      /* Cleanup cannot resurrect an invalidated snapshot. */
    }
  }
  invalidate(): void {
    for (const snapshot of this.snapshots.values()) this.drop(snapshot);
  }
  private debit(snapshot: Snapshot, amount: number): void {
    if (snapshot.operations >= 1024 || snapshot.readBytes + amount > CONTROLLER_SERVICE_MAX_BYTES)
      throw new CatalogReadRefusal("resource_limit");
    snapshot.operations++;
    snapshot.readBytes += amount;
  }
  private pagePayload(snapshot: Snapshot, position: number, requestId: string): Page {
    const payload: Page = {
      requestId,
      status: "ok",
      version: 1,
      snapshotId: snapshot.id,
      revision: snapshot.revision,
      manifestHash: snapshot.manifestHash,
      expiresAt: snapshot.expiresAt,
      entries: structuredClone(snapshot.pages[position]!),
      nextCursor: snapshot.cursors[position + 1] ?? null,
      trust: structuredClone(snapshot.trust),
    };
    if (bytes(payload) > PLUGIN_CATALOG_PAGE_BYTES) throw new CatalogReadRefusal("resource_limit");
    return payload;
  }

  async open(
    reader: object,
    guard: Guard,
    close: () => void,
    trust: PluginCatalogTrust,
    requestId: string,
    requestGuard: Guard = guard,
  ): Promise<Page> {
    const createdAt = this.charge(requestGuard);
    check(guard);
    const state = await this.readState();
    check(requestGuard);
    check(guard);
    if (state.revision !== this.currentRevision()) throw new CatalogReadRefusal("stale_snapshot");
    this.now();
    if (state.entries.length > 128 || this.snapshots.size >= 8)
      throw new CatalogReadRefusal("resource_limit");
    const frozenTrust = PluginCatalogTrustSchema.parse(trust);
    let sourceBytes = 0;
    const entries = state.entries
      .map((entry) => {
        const size = bytes(entry);
        sourceBytes += size;
        // Preserve the existing FULL entry and aggregate source bounds, including escaped JSON.
        if (size > 1024 * 1024 || sourceBytes > CONTROLLER_SERVICE_MAX_BYTES)
          throw new CatalogReadRefusal("resource_limit");
        return PluginCatalogDescriptorSchema.parse({
          id: entry.id,
          ...(entry.requirements ? { requirements: entry.requirements } : {}),
          bundle: {
            reference: randomUUID(),
            sha256: hash(entry.clientBundle),
            byteLength: Buffer.byteLength(entry.clientBundle),
          },
        });
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    if (
      bytes({
        type: "session",
        message: {
          type: "plugin.catalog.get.response",
          payload: { requestId, plugins: state.entries, ...frozenTrust },
        },
      }) > CONTROLLER_SERVICE_MAX_BYTES
    )
      throw new CatalogReadRefusal("resource_limit");
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new CatalogReadRefusal("invalid_request");
    const id = randomUUID(),
      expiresAt = createdAt + PLUGIN_CATALOG_SNAPSHOT_TTL_MS;
    if (expiresAt <= this.now()) throw new CatalogReadRefusal("expired");
    const manifestHash = hash(
      canonicalJson({ version: 1, revision: state.revision, entries, trust: frozenTrust }),
    );
    const snapshot: Snapshot = {
      id,
      revision: state.revision,
      manifestHash,
      createdAt,
      expiresAt,
      reader,
      guard,
      close,
      trust: frozenTrust,
      entries,
      pages: [[]],
      cursors: [randomUUID()],
      operations: 0,
      readBytes: 0,
      retainedBytes: 0,
    };
    for (const entry of entries) {
      const last = snapshot.pages.at(-1)!;
      last.push(entry);
      const position = snapshot.pages.length - 1;
      // Reserve a UUID cursor even on the final page so size cannot grow on pagination.
      if (
        last.length > 16 ||
        bytes({
          ...this.pagePayloadUnchecked(snapshot, position, requestId),
          nextCursor: randomUUID(),
        }) > PLUGIN_CATALOG_PAGE_BYTES
      ) {
        last.pop();
        if (!last.length) throw new CatalogReadRefusal("resource_limit");
        snapshot.pages.push([entry]);
        snapshot.cursors.push(randomUUID());
        if (
          bytes({
            ...this.pagePayloadUnchecked(snapshot, position + 1, requestId),
            nextCursor: randomUUID(),
          }) > PLUGIN_CATALOG_PAGE_BYTES
        )
          throw new CatalogReadRefusal("resource_limit");
      }
    }
    snapshot.retainedBytes = bytes({
      id,
      revision: snapshot.revision,
      manifestHash,
      createdAt,
      expiresAt,
      trust: frozenTrust,
      entries,
      pages: snapshot.pages,
      cursors: snapshot.cursors,
      operations: 1024,
      readBytes: CONTROLLER_SERVICE_MAX_BYTES,
    });
    if (
      snapshot.retainedBytes > 256 * 1024 ||
      this.retainedBytes + snapshot.retainedBytes > 2 * 1024 * 1024
    )
      throw new CatalogReadRefusal("resource_limit");
    check(guard);
    if (state.revision !== this.currentRevision()) throw new CatalogReadRefusal("stale_snapshot");
    this.debit(snapshot, 0);
    const payload = this.pagePayload(snapshot, 0, requestId);
    check(guard);
    check(requestGuard);
    this.snapshots.set(id, snapshot);
    this.retainedBytes += snapshot.retainedBytes;
    snapshot.timer = setTimeout(() => this.drop(snapshot), Math.max(0, expiresAt - this.clock()));
    snapshot.timer.unref?.();
    return payload;
  }
  private pagePayloadUnchecked(snapshot: Snapshot, position: number, requestId: string) {
    return {
      requestId,
      status: "ok",
      version: 1,
      snapshotId: snapshot.id,
      revision: snapshot.revision,
      manifestHash: snapshot.manifestHash,
      expiresAt: snapshot.expiresAt,
      entries: snapshot.pages[position],
      nextCursor: null,
      trust: snapshot.trust,
    };
  }

  async page(reader: object, cursor: string, guard: Guard, requestId: string): Promise<Page> {
    this.charge(guard);
    const snapshot = [...this.snapshots.values()].find((value) => value.cursors.includes(cursor));
    if (!snapshot) throw new CatalogReadRefusal("unavailable");
    this.require(snapshot, reader, guard);
    this.debit(snapshot, 0);
    const payload = this.pagePayload(snapshot, snapshot.cursors.indexOf(cursor), requestId);
    this.require(snapshot, reader, guard);
    return payload;
  }

  async bundle(
    reader: object,
    id: string,
    reference: string,
    offset: number,
    length: number,
    guard: Guard,
    requestId: string,
  ): Promise<Chunk> {
    this.charge(guard);
    const snapshot = this.lookup(id, reader, guard);
    const descriptor = snapshot.entries.find((entry) => entry.bundle.reference === reference);
    if (
      !descriptor ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 65536 ||
      offset > descriptor.bundle.byteLength
    )
      throw new CatalogReadRefusal("invalid_request");
    const state = await this.readState();
    this.require(snapshot, reader, guard);
    const entry = state.entries.find((value) => value.id === descriptor.id);
    if (
      state.revision !== snapshot.revision ||
      !entry ||
      hash(entry.clientBundle) !== descriptor.bundle.sha256 ||
      Buffer.byteLength(entry.clientBundle) !== descriptor.bundle.byteLength
    )
      throw new CatalogReadRefusal("stale_snapshot");
    const content = Buffer.from(entry.clientBundle);
    const chunk = content.subarray(offset, Math.min(offset + length, content.length));
    const payload: Chunk = {
      requestId,
      status: "ok",
      version: 1,
      snapshotId: id,
      revision: snapshot.revision,
      manifestHash: snapshot.manifestHash,
      expiresAt: snapshot.expiresAt,
      reference,
      sha256: descriptor.bundle.sha256,
      offset,
      totalBytes: content.length,
      data: chunk.toString("base64"),
      eof: offset + chunk.length === content.length,
    };
    if (bytes(payload) > PLUGIN_CATALOG_REPLY_BYTES) throw new CatalogReadRefusal("resource_limit");
    this.require(snapshot, reader, guard);
    this.debit(snapshot, chunk.length);
    return payload;
  }
  discard(reader: object, id: string): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot?.reader === reader) this.drop(snapshot);
  }

  checkPublication(reader: object, id: string, guard: Guard): void {
    this.lookup(id, reader, guard);
  }

  release(reader: object, id: string, guard: Guard): void {
    this.charge(guard);
    const snapshot = this.lookup(id, reader, guard);
    this.drop(snapshot);
  }
}

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm, rename, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";
import { nativeEvidenceDigest } from "../native-evidence-origin.js";
import { NativeArtifactStore } from "../native-artifact-store.js";
import {
  NativeEvidenceReadOutputSchema,
  ManagedArtifactReadOutputSchema,
  type ManagedArtifactClaim,
  type NativeEvidenceClaim,
  type NativeEvidenceJournal,
} from "@getpaseo/protocol/native-evidence";
// Native authority writes and descriptor confinement require POSIX host primitives.
const posixTest = test.runIf(process.platform !== "win32");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const identity = () => ({
  agentId: randomUUID(),
  instanceId: randomUUID(),
  sessionId: "native",
  boot: randomUUID(),
});
function claim(): NativeEvidenceClaim {
  const at = Date.now();
  const body = {
    version: 3 as const,
    recordType: "native_evidence_attempt" as const,
    source: identity(),
    sourceEpoch: randomUUID(),
    recipient: identity(),
    recipientEpoch: randomUUID(),
    completionBodyDigest: nativeEvidenceDigest({ ack: true }),
    entry: {
      id: randomUUID(),
      operationDigest: nativeEvidenceDigest({ operation: true }),
      scope: { projectId: randomUUID(), taskId: randomUUID() },
      at,
      expiresAt: at + 60000,
    },
  };
  return { ...body, bytes: 4096, fingerprint: nativeEvidenceDigest(body) };
}
function outcome(c: NativeEvidenceClaim): NativeEvidenceJournal {
  const { fingerprint: _fingerprint, bytes, ...captured } = c;
  const body = {
    ...captured,
    recordType: "native_evidence" as const,
    entry: {
      ...c.entry,
      fact: { kind: "command_result" as const, basis: "native_provider_ack" as const, exitCode: 0 },
      metadataCommitted: true as const,
    },
  };
  return { ...body, bytes, fingerprint: nativeEvidenceDigest(body) };
}
async function fixture(limit = 10000) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-evidence-fake-"));
  dirs.push(directory);
  return { directory, ledger: new MessageReceipts(directory, Date.now, limit) };
}
posixTest(
  "native evidence durable attempt survives restart, no replay, scoped completed metadata only",
  async () => {
    const { directory, ledger } = await fixture();
    const c = claim();
    expect(await ledger.prepareEvidence(c, () => {})).toBe(true);
    const restarted = new MessageReceipts(directory);
    expect(await restarted.prepareEvidence(c, () => {})).toBe(false);
    expect(
      await restarted.evidenceIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).toEqual([]);
    // A current in-process origin may finish; recovery itself never reconstructs an origin or performs effects.
    await ledger.appendEvidence(outcome(c), () => {});
    await ledger.appendEvidence(outcome(c), () => {});
    expect(
      await new MessageReceipts(directory).evidenceIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).toHaveLength(1);
    expect(
      await ledger.evidenceIndex(
        c.recipient.agentId,
        randomUUID(),
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).toEqual([]);
    await expect(
      ledger.prepareEvidence(
        { ...c, completionBodyDigest: nativeEvidenceDigest({ changed: true }) },
        () => {},
      ),
    ).rejects.toThrow("conflict");
  },
);
posixTest(
  "native evidence permanent-ID ceiling does not prune attempts or hide owner maintenance refusal",
  async () => {
    const { directory, ledger } = await fixture(1);
    const c = claim();
    await ledger.prepareEvidence(c, () => {});
    expect(await ledger.prepareEvidence(c, () => {})).toBe(false);
    await expect(ledger.prepareEvidence(claim(), () => {})).rejects.toThrow("maintenance");
    await expect(
      new MessageReceipts(directory, Date.now, 1).prepareEvidence(claim(), () => {}),
    ).rejects.toThrow("maintenance");
  },
);
posixTest(
  "native evidence append and protected read fail closed after authorization loss",
  async () => {
    const { ledger } = await fixture();
    const c = claim();
    await ledger.prepareEvidence(c, () => {});
    let checks = 0;
    await expect(
      ledger.appendEvidence(outcome(c), () => {
        if (++checks >= 4) throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    await expect(
      ledger.evidenceIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("durability");
  },
);
posixTest(
  "native evidence corruption fails closed, never reconstructs delivery or materialization",
  async () => {
    const { directory, ledger } = await fixture();
    const c = claim();
    await ledger.prepareEvidence(c, () => {});
    const file = path.join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.completionBodyDigest = nativeEvidenceDigest({ tamper: true });
    await writeFile(file, JSON.stringify(record));
    await expect(
      new MessageReceipts(directory).evidenceIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("corrupt");
  },
);
posixTest(
  "native evidence shares per-target ticket cap with action queue and snapshot refuses mutable caller",
  async () => {
    const { ledger } = await fixture();
    const first = claim();
    for (let i = 0; i < 32; i++) {
      const c = claim();
      c.recipient = first.recipient;
      const { fingerprint: _fingerprint, bytes: _bytes, ...body } = c;
      c.fingerprint = nativeEvidenceDigest(body);
      await ledger.prepareEvidence(c, () => {});
    }
    await expect(
      ledger.enqueue({
        agentId: first.recipient.agentId,
        messageId: "action",
        boot: "boot",
        principal: { kind: "fake" },
        request: { text: "private fake" },
        attachmentBytes: 0,
        authorize: () => {},
      }),
    ).rejects.toThrow("shared resource");
  },
);

posixTest(
  "native evidence original native operation ID survives epoch and boot changes without rematerialization",
  async () => {
    const { ledger } = await fixture();
    const c = claim();
    await ledger.prepareEvidence(c, () => {});
    const changed = {
      ...c,
      source: { ...c.source, boot: randomUUID() },
      sourceEpoch: randomUUID(),
    };
    const { fingerprint: _fingerprint, bytes: _bytes, ...body } = changed;
    changed.fingerprint = nativeEvidenceDigest(body);
    await expect(ledger.prepareEvidence(changed, () => {})).rejects.toThrow("conflict");
  },
);

function managedClaim(bytes: Uint8Array): ManagedArtifactClaim {
  const { fingerprint: _fingerprint, bytes: _bytes, ...legacy } = claim();
  const body = {
    ...legacy,
    version: 4 as const,
    recordType: "native_managed_artifact_attempt" as const,
    artifactReservation: {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  return { ...body, bytes: 4096, fingerprint: nativeEvidenceDigest(body) };
}

posixTest(
  "managed artifacts preserve the legacy namespace and permanently refuse rematerialization",
  async () => {
    const { ledger, directory } = await fixture();
    const bytes = Buffer.from("throwaway declared bytes");
    const c = managedClaim(bytes);
    const record = await ledger.produceDeclaredArtifact(c, bytes, () => {});
    expect(record.entry.fact.basis).toBe("host_materialized_declared_output");
    expect(await readFile(path.join(directory, "artifacts", `${c.entry.id}.blob`))).toEqual(bytes);
    const restarted = new MessageReceipts(directory);
    const entries = await restarted.managedArtifactIndex(
      c.recipient.agentId,
      c.recipientEpoch,
      c.entry.scope,
      () => {},
      () => {},
    );
    expect(entries).toHaveLength(1);
    const response = {
      scope: c.entry.scope,
      entries: entries.map((r) => r.entry),
      bounded: true,
      contentReadAvailable: false,
    };
    expect(ManagedArtifactReadOutputSchema.safeParse(response).success).toBe(true);
    expect(NativeEvidenceReadOutputSchema.safeParse(response).success).toBe(false);
    expect(
      await restarted.evidenceIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).toEqual([]);
    await expect(restarted.produceDeclaredArtifact(c, bytes, () => {})).rejects.toThrow(
      "already attempted",
    );
    const changed = managedClaim(Buffer.from("changed bytes"));
    changed.entry.id = c.entry.id;
    const { fingerprint: _fingerprint, bytes: _bytes, ...body } = changed;
    changed.fingerprint = nativeEvidenceDigest(body);
    await expect(
      restarted.produceDeclaredArtifact(changed, Buffer.from("changed bytes"), () => {}),
    ).rejects.toThrow("already attempted");
    expect(await readdir(path.join(directory, "artifacts"))).toEqual([`${c.entry.id}.blob`]);
  },
);

posixTest(
  "managed artifact failed materialization keeps a durable attempt and cannot replay on restart",
  async () => {
    const { ledger, directory } = await fixture();
    const bytes = Buffer.from("bounded failed bytes"),
      c = managedClaim(bytes);
    await expect(
      ledger.produceDeclaredArtifact(c, bytes, () => {
        // Refuse only once the durable reservation is published and before bytes are written.
        if (Reflect.get(ledger, "managedClaims").size) throw new Error("owner revoked");
      }),
    ).rejects.toThrow("owner revoked");
    const restarted = new MessageReceipts(directory);
    await expect(restarted.produceDeclaredArtifact(c, bytes, () => {})).rejects.toThrow(
      "already attempted",
    );
    expect(
      await restarted.managedArtifactIndex(
        c.recipient.agentId,
        c.recipientEpoch,
        c.entry.scope,
        () => {},
        () => {},
      ),
    ).toEqual([]);
    expect((await readdir(directory)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  },
);

posixTest("managed artifact storage reservations survive metadata expiry and restart", async () => {
  const { ledger, directory } = await fixture();
  const bytes = Buffer.alloc(128 * 1024, 65),
    first = managedClaim(bytes);
  for (let i = 0; i < 3; i++) {
    const c = managedClaim(bytes);
    c.recipient = first.recipient;
    const { fingerprint: _fingerprint, bytes: _bytes, ...body } = c;
    c.fingerprint = nativeEvidenceDigest(body);
    await ledger.produceDeclaredArtifact(c, bytes, () => {});
  }
  const restarted = new MessageReceipts(directory, () => Date.now() + 7 * 3600000);
  const fourth = managedClaim(bytes);
  fourth.recipient = first.recipient;
  fourth.entry.at = Date.now() + 7 * 3600000;
  fourth.entry.expiresAt = fourth.entry.at + 60000;
  const { fingerprint: _fingerprint, bytes: _bytes, ...body } = fourth;
  fourth.fingerprint = nativeEvidenceDigest(body);
  await expect(restarted.produceDeclaredArtifact(fourth, bytes, () => {})).rejects.toThrow(
    "shared resource",
  );
  expect(
    await restarted.managedArtifactIndex(
      first.recipient.agentId,
      first.recipientEpoch,
      first.entry.scope,
      () => {},
      () => {},
    ),
  ).toEqual([]);
});

posixTest(
  "managed artifact confinement refuses hardlinks and a renamed root without resetting storage",
  async () => {
    const { directory } = await fixture();
    const store = new NativeArtifactStore(path.join(directory, "artifacts"));
    const id = randomUUID(),
      bytes = Buffer.from("private fixture");
    const reference = store.write(id, bytes, () => {});
    await link(path.join(directory, "artifacts", `${id}.blob`), path.join(directory, "alias"));
    expect(() => store.read(id, reference, () => {})).toThrow("reference changed");
    await rm(path.join(directory, "alias"));
    await rename(path.join(directory, "artifacts"), path.join(directory, "moved"));
    expect(() => store.write(randomUUID(), bytes, () => {})).toThrow();
    expect(await readdir(directory)).toEqual(["moved"]);
    expect(await readFile(path.join(directory, "moved", `${id}.blob`))).toEqual(bytes);
  },
);

posixTest(
  "managed artifact pre-effect limits and exclusive destination leave existing bytes intact",
  async () => {
    const { directory } = await fixture();
    const store = new NativeArtifactStore(path.join(directory, "artifacts")),
      id = randomUUID();
    expect(() => store.write(id, Buffer.alloc(128 * 1024 + 1), () => {})).toThrow("size refused");
    expect(await readdir(directory)).toEqual([]);
    store.write(id, Buffer.from("original"), () => {});
    expect(() => store.write(id, Buffer.from("replacement"), () => {})).toThrow();
    expect(await readFile(path.join(directory, "artifacts", `${id}.blob`), "utf8")).toBe(
      "original",
    );
  },
);

posixTest.each(["orphan", "missing-committed"] as const)(
  "managed artifact recovery refuses %s storage before another materialization",
  async (change) => {
    const { ledger, directory } = await fixture();
    const bytes = Buffer.from("retained declaration"),
      first = managedClaim(bytes);
    await ledger.produceDeclaredArtifact(first, bytes, () => {});
    if (change === "orphan")
      await writeFile(
        path.join(directory, "artifacts", `${randomUUID()}.blob`),
        "unreserved bytes",
        { mode: 0o600 },
      );
    else await rm(path.join(directory, "artifacts", `${first.entry.id}.blob`));
    const next = managedClaim(bytes);
    await expect(
      new MessageReceipts(directory).produceDeclaredArtifact(next, bytes, () => {}),
    ).rejects.toThrow("storage");
    expect(
      (await readdir(path.join(directory, "artifacts"))).includes(`${next.entry.id}.blob`),
    ).toBe(false);
  },
);

async function contentFixture(budget = 8, sessionId = "native") {
  const { directory, ledger } = await fixture();
  const bytes = Buffer.from("abcdefghijklmnopqrstuvwx");
  const c = managedClaim(bytes);
  c.recipient.sessionId = sessionId;
  const { fingerprint: _fingerprint, bytes: _reserved, ...body } = c;
  c.fingerprint = nativeEvidenceDigest(body);
  await ledger.produceDeclaredArtifact(c, bytes, () => {});
  const grant = {
    grantId: randomUUID(),
    revision: randomUUID(),
    identity: c.recipient,
    expectedEpoch: c.recipientEpoch,
    scope: c.entry.scope,
    artifactIds: [c.entry.id],
    byteBudget: budget,
    expiresAt: Date.now() + 60000,
  };
  const input = {
    requestId: randomUUID(),
    grantId: grant.grantId,
    grantRevision: grant.revision,
    identity: c.recipient,
    expectedEpoch: c.recipientEpoch,
    scope: c.entry.scope,
    artifactId: c.entry.id,
    offset: 0,
    length: 8,
  };
  return { directory, ledger, bytes, c, grant, input };
}

posixTest(
  "content purpose atomic concurrent debit and restart retain aggregate budget without replay",
  async () => {
    const f = await contentFixture();
    const results = await Promise.allSettled([
      f.ledger.readManagedArtifactContent(
        f.input,
        f.grant,
        () => {},
        () => {},
      ),
      f.ledger.readManagedArtifactContent(
        { ...f.input, requestId: randomUUID() },
        f.grant,
        () => {},
        () => {},
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const completed = results.find((r) => r.status === "fulfilled");
    if (completed?.status !== "fulfilled") throw new Error("Expected one bounded chunk");
    expect(Buffer.from(completed.value.data, "base64")).toEqual(f.bytes.subarray(0, 8));
    await expect(
      new MessageReceipts(f.directory).readManagedArtifactContent(
        { ...f.input, requestId: randomUUID() },
        f.grant,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("budget exhausted");
    await expect(
      new MessageReceipts(f.directory).readManagedArtifactContent(
        f.input,
        f.grant,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("already attempted");
    const lowered = { ...f.grant, revision: randomUUID(), byteBudget: 4 };
    await expect(
      new MessageReceipts(f.directory).readManagedArtifactContent(
        { ...f.input, requestId: randomUUID(), grantRevision: lowered.revision, length: 1 },
        lowered,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("budget exhausted");
  },
);

posixTest(
  "content purpose captured offset/body and grant snapshots cannot be changed by caller",
  async () => {
    const f = await contentFixture();
    const pending = f.ledger.readManagedArtifactContent(
      f.input,
      f.grant,
      () => {},
      () => {},
    );
    f.input.offset = 1000;
    f.input.length = 8192;
    f.grant.byteBudget = 1;
    f.grant.artifactIds.length = 0;
    const output = await pending;
    expect(output).toMatchObject({ offset: 0, length: 8 });
    expect(Buffer.from(output.data, "base64")).toEqual(f.bytes.subarray(0, 8));
  },
);

posixTest(
  "content purpose refusal after durable debit consumes allowance and cannot retry after restart",
  async () => {
    const f = await contentFixture();
    await expect(
      f.ledger.readManagedArtifactContent(
        f.input,
        f.grant,
        () => {
          if (Reflect.get(f.ledger, "contentDebits").size) throw new Error("recipient revoked");
        },
        () => {},
      ),
    ).rejects.toThrow("recipient revoked");
    await expect(
      new MessageReceipts(f.directory).readManagedArtifactContent(
        { ...f.input, requestId: randomUUID() },
        f.grant,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("budget exhausted");
  },
);

posixTest.each(["range", "wrong-artifact", "expired"] as const)(
  "content purpose %s refuses before debit or byte disclosure",
  async (failure) => {
    const f = await contentFixture();
    if (failure === "range") f.input.offset = Number.MAX_SAFE_INTEGER;
    else if (failure === "wrong-artifact") f.input.artifactId = randomUUID();
    else f.grant.expiresAt = Date.now() - 1;
    await expect(
      f.ledger.readManagedArtifactContent(
        f.input,
        f.grant,
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
    expect(Reflect.get(f.ledger, "contentDebits").size).toBe(0);
  },
);

posixTest(
  "content purpose persisted root identity rejects reparented original inode after adapter restart",
  async () => {
    const { directory } = await fixture();
    const original = path.join(directory, "original"),
      changed = path.join(directory, "changed"),
      id = randomUUID();
    const store = new NativeArtifactStore(original),
      bytes = Buffer.from("same private inode");
    const reference = store.write(id, bytes, () => {});
    const moved = new NativeArtifactStore(changed);
    moved.write(randomUUID(), Buffer.from("initialize separate private root"), () => {});
    await rename(path.join(original, `${id}.blob`), path.join(changed, `${id}.blob`));
    expect(() => new NativeArtifactStore(changed).read(id, reference, () => {})).toThrow(
      "root proof",
    );
    const legacy = {
      dev: reference.dev,
      ino: reference.ino,
      size: reference.size,
      sha256: reference.sha256,
    };
    expect(() => new NativeArtifactStore(changed).read(id, legacy, () => {})).toThrow("root proof");
  },
);

posixTest("content purpose encoded reservation corruption fails closed on recovery", async () => {
  const f = await contentFixture();
  await f.ledger.readManagedArtifactContent(
    f.input,
    f.grant,
    () => {},
    () => {},
  );
  for (const file of (await readdir(f.directory)).filter((name) => name.endsWith(".json"))) {
    const record = JSON.parse(await readFile(path.join(f.directory, file), "utf8"));
    if (record.recordType === "native_artifact_content_debit") {
      record.bytes -= 1;
      await writeFile(path.join(f.directory, file), JSON.stringify(record));
    }
  }
  await expect(
    new MessageReceipts(f.directory).readManagedArtifactContent(
      { ...f.input, requestId: randomUUID() },
      f.grant,
      () => {},
      () => {},
    ),
  ).rejects.toThrow("corrupt");
});

posixTest(
  "content purpose artifact TTL expiry after debit refuses even while independent grant is live",
  async () => {
    const f = await contentFixture();
    f.grant.expiresAt = Date.now() + 120000;
    let clock = Date.now();
    Reflect.set(f.ledger, "now", () => clock);
    await expect(
      f.ledger.readManagedArtifactContent(
        f.input,
        f.grant,
        () => {
          if (Reflect.get(f.ledger, "contentDebits").size) clock = f.c.entry.expiresAt + 1;
        },
        () => {},
      ),
    ).rejects.toThrow("expired");
    expect(Reflect.get(f.ledger, "contentDebits").size).toBe(1);
  },
);

posixTest(
  "content purpose escaped maximum identity reserves actual encoded debit before commit and survives restart",
  async () => {
    const f = await contentFixture(128 * 1024, "\u0000".repeat(200));
    f.input.length = 1;
    await f.ledger.readManagedArtifactContent(
      f.input,
      f.grant,
      () => {},
      () => {},
    );
    const debits = await Promise.all(
      (await readdir(f.directory))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(await readFile(path.join(f.directory, file), "utf8"))),
    );
    const debit = debits.find((record) => record.recordType === "native_artifact_content_debit");
    expect(Buffer.byteLength(JSON.stringify(debit))).toBeLessThanOrEqual(debit.bytes);
    const restarted = new MessageReceipts(f.directory);
    await expect(
      restarted.readManagedArtifactContent(
        f.input,
        f.grant,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("already attempted");
    await expect(
      restarted.readManagedArtifactContent(
        { ...f.input, requestId: randomUUID() },
        { ...f.grant, byteBudget: 1 },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("budget exhausted");
  },
);

test.runIf(process.platform === "win32")(
  "Windows refuses native evidence durability before publishing an attempt",
  async () => {
    const { directory, ledger } = await fixture();
    await expect(ledger.prepareEvidence(claim(), () => {})).rejects.toMatchObject({
      code: "NATIVE_DURABILITY_UNAVAILABLE",
    });
    expect(await readdir(directory)).toEqual([]);
  },
);

test.runIf(process.platform === "win32")(
  "Windows refuses native artifact confinement before creating byte storage",
  async () => {
    const { directory } = await fixture();
    const artifacts = new NativeArtifactStore(path.join(directory, "artifacts"));
    expect(() => artifacts.write("a".repeat(64), Buffer.from("fixture"), () => {})).toThrow(
      "Native artifact confinement unavailable",
    );
    expect(await readdir(directory)).toEqual([]);
  },
);

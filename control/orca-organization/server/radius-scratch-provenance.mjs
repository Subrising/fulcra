import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MANIFEST = "attempt.json";
const TEMP = ".attempt.tmp";
const OUTPUTS = [
  "app.bicep",
  "requirements.json",
  "infra-change.json",
  "deployment-simulation.json",
];
const LEAVES = [...OUTPUTS, MANIFEST];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 4096;
const MAX_OUTPUTS = 65536;
const active = new Set();
const refuse = () => {
  throw new Error("Radius scratch simulation is unavailable or refused.");
};
class OriginalSourceRefused extends Error {}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function keys(value, expected) {
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join(",") === expected.split(",").sort().join(",")
  );
}
function identity(stat, mode) {
  if (
    !integer(stat.dev) ||
    !integer(stat.ino) ||
    !integer(stat.uid) ||
    (stat.mode & 0o7777) !== mode ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    refuse();
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode };
}
function directory(name, expected) {
  const stat = fs.lstatSync(name);
  if (!stat.isDirectory()) refuse();
  const id = identity(stat, 0o700);
  if (expected && (!same(expected, id) || expected.uid !== id.uid)) refuse();
  return id;
}
function fileStat(stat) {
  if (!stat.isFile() || stat.nlink !== 1) refuse();
  return { ...identity(stat, 0o600), nlink: 1 };
}
function idValid(id, mode, leaf = false) {
  if (!keys(id, leaf ? "dev,ino,uid,mode,nlink" : "dev,ino,uid,mode")) return false;
  return (
    integer(id.dev) &&
    integer(id.ino) &&
    integer(id.uid) &&
    id.mode === mode &&
    (!leaf || id.nlink === 1)
  );
}
function readBound(leaf, limit) {
  const descriptor = fs.fstatSync(leaf.fd);
  const id = fileStat(descriptor);
  const named = fileStat(fs.lstatSync(leaf.name));
  if (
    !same(leaf.id, id) ||
    !same(id, named) ||
    descriptor.size > limit ||
    !integer(descriptor.size)
  )
    refuse();
  const bytes = Buffer.alloc(descriptor.size);
  if (fs.readSync(leaf.fd, bytes, 0, bytes.length, 0) !== bytes.length) refuse();
  return bytes;
}
function capture(name, limit) {
  const named = fs.lstatSync(name);
  const namedId = fileStat(named);
  if (!integer(named.size) || named.size > limit) refuse();
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (
    !Number.isInteger(O_NOFOLLOW) ||
    O_NOFOLLOW === 0 ||
    !Number.isInteger(O_NONBLOCK) ||
    O_NONBLOCK === 0
  )
    refuse();
  // A named regular leaf can become a FIFO before open. Never block or retarget it.
  const fd = fs.openSync(name, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const id = fileStat(fs.fstatSync(fd));
    if (!same(namedId, id) || namedId.uid !== id.uid) refuse();
    const leaf = { fd, name, id: namedId };
    const bytes = readBound(leaf, limit);
    return { ...leaf, bytes: bytes.length, sha256: hash(bytes), value: bytes };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function verify(leaf, limit) {
  const bytes = readBound(leaf, limit);
  if (bytes.length !== leaf.bytes || hash(bytes) !== leaf.sha256) refuse();
}
function recordValid(record, attemptId) {
  if (!keys(record, "format,producer,attemptId,root,attempt,order,revisionDigest,outputs"))
    return false;
  if (
    record.format !== 1 ||
    record.producer !== "fulcra-radius-scratch-v1" ||
    record.attemptId !== attemptId ||
    !UUID.test(attemptId) ||
    !integer(record.order) ||
    record.order === 0 ||
    record.order >= Number.MAX_SAFE_INTEGER ||
    !DIGEST.test(record.revisionDigest)
  )
    return false;
  if (
    !idValid(record.root, 0o700) ||
    !idValid(record.attempt, 0o700) ||
    !Array.isArray(record.outputs) ||
    record.outputs.length !== 4
  )
    return false;
  let total = 0;
  for (let i = 0; i < OUTPUTS.length; i++) {
    const row = record.outputs[i];
    if (
      !keys(row, "file,identity,bytes,sha256") ||
      row.file !== OUTPUTS[i] ||
      !idValid(row.identity, 0o600, true) ||
      !integer(row.bytes) ||
      !DIGEST.test(row.sha256)
    )
      return false;
    total += row.bytes;
  }
  return total <= MAX_OUTPUTS;
}
function exactLeaves(attempt) {
  if (fs.readdirSync(attempt).sort().join(",") !== [...LEAVES].sort().join(",")) refuse();
}
function absent(name) {
  try {
    fs.lstatSync(name);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  refuse();
}
function close(candidate) {
  for (const leaf of candidate.leaves) fs.closeSync(leaf.fd);
}

// A supplies the CURRENT ORIGINAL physical guards. Private provenance never grants
// deletion rights or promises lifetime UUID protection after an explicit eviction.
export function createRadiusProvenance({ root, assertCurrentOwner, assertCurrentPruneOwner }) {
  function owner(prune = false) {
    try {
      const invoke = (callback) => {
        if (typeof callback !== "function") refuse();
        const result = callback();
        if (result && typeof result.then === "function") refuse();
      };
      invoke(assertCurrentOwner);
      if (prune) {
        invoke(assertCurrentPruneOwner);
        invoke(assertCurrentOwner);
      }
    } catch {
      throw new OriginalSourceRefused("Radius scratch simulation is unavailable or refused.");
    }
  }
  function checkRoot(rootId, prune = false) {
    owner(prune);
    directory(root, rootId);
  }
  function recover(attemptId, rootId, prune = false, full = false) {
    const attempt = path.join(root, attemptId);
    const leaves = [];
    try {
      checkRoot(rootId, prune);
      const attemptIdActual = directory(attempt);
      const manifest = capture(path.join(attempt, MANIFEST), MAX_MANIFEST);
      leaves.push(manifest);
      const record = JSON.parse(manifest.value.toString("utf8"));
      if (
        !Buffer.from(JSON.stringify(record) + "\n").equals(manifest.value) ||
        !recordValid(record, attemptId) ||
        !same(record.root, rootId) ||
        record.root.uid !== rootId.uid ||
        !same(record.attempt, attemptIdActual) ||
        record.attempt.uid !== attemptIdActual.uid
      )
        refuse();
      exactLeaves(attempt);
      if (full) {
        for (const row of record.outputs) {
          checkRoot(rootId, prune);
          directory(attempt, record.attempt);
          const leaf = capture(path.join(attempt, row.file), MAX_OUTPUTS);
          leaves.push(leaf);
          if (
            !same(row.identity, leaf.id) ||
            row.identity.uid !== leaf.id.uid ||
            row.bytes !== leaf.bytes ||
            row.sha256 !== leaf.sha256
          )
            refuse();
        }
      }
      checkRoot(rootId, prune);
      return { attempt, record, leaves };
    } catch (error) {
      close({ leaves });
      if (error instanceof OriginalSourceRefused) throw error;
      return null;
    }
  }
  function collected(rootId, prune, full) {
    checkRoot(rootId, prune);
    const names = fs.readdirSync(root);
    if (names.length > 64) refuse();
    const candidates = [];
    try {
      for (const name of names) {
        if (!UUID.test(name) || active.has(path.join(root, name))) continue;
        const candidate = recover(name, rootId, prune, full);
        if (candidate) candidates.push(candidate);
      }
      return candidates;
    } catch (error) {
      for (const candidate of candidates) close(candidate);
      throw error;
    }
  }
  function pruneCandidate(candidate, rootId) {
    const ordered = [...candidate.leaves.slice(1), candidate.leaves[0]];
    // Validate the ENTIRE candidate again before its first destructive effect.
    for (const leaf of ordered) {
      checkRoot(rootId, true);
      directory(candidate.attempt, candidate.record.attempt);
      exactLeaves(candidate.attempt);
      verify(leaf, leaf.name.endsWith(MANIFEST) ? MAX_MANIFEST : MAX_OUTPUTS);
    }
    const remaining = [...ordered];
    for (const leaf of ordered) {
      checkRoot(rootId, true);
      directory(candidate.attempt, candidate.record.attempt);
      if (
        fs.readdirSync(candidate.attempt).sort().join(",") !==
        remaining
          .map((row) => path.basename(row.name))
          .sort()
          .join(",")
      )
        refuse();
      for (const row of remaining)
        verify(row, row.name.endsWith(MANIFEST) ? MAX_MANIFEST : MAX_OUTPUTS);
      verify(leaf, leaf.name.endsWith(MANIFEST) ? MAX_MANIFEST : MAX_OUTPUTS);
      fs.unlinkSync(leaf.name);
      remaining.shift();
    }
    checkRoot(rootId, true);
    directory(candidate.attempt, candidate.record.attempt);
    if (fs.readdirSync(candidate.attempt).length !== 0) refuse();
    fs.rmdirSync(candidate.attempt);
  }
  function reserve(rootId, attemptId) {
    const names = fs.readdirSync(root);
    if (names.includes(attemptId)) refuse();
    if (names.length < 64) return;
    checkRoot(rootId, true);
    const candidates = collected(rootId, true, true);
    try {
      const orders = new Map();
      for (const c of candidates) orders.set(c.record.order, (orders.get(c.record.order) ?? 0) + 1);
      candidates.sort((a, b) => a.record.order - b.record.order);
      for (const candidate of candidates) {
        checkRoot(rootId, true);
        if (fs.readdirSync(root).length <= 48) break;
        if (orders.get(candidate.record.order) !== 1) continue;
        pruneCandidate(candidate, rootId);
      }
      checkRoot(rootId, true);
      if (fs.readdirSync(root).length >= 64) refuse();
    } finally {
      for (const candidate of candidates) close(candidate);
    }
  }
  function publish({ rootStat, attemptStat, attemptId, revision, opened, outputs, effect }) {
    const rootId = identity(rootStat, 0o700);
    const attemptIdActual = identity(attemptStat, 0o700);
    const candidates = collected(rootId, false, false);
    let order = 1;
    try {
      for (const c of candidates) order = Math.max(order, c.record.order + 1);
    } finally {
      for (const c of candidates) close(c);
    }
    if (!Number.isSafeInteger(order)) refuse();
    const rows = opened.map((leaf, i) => ({
      file: outputs[i].file,
      identity: fileStat(fs.fstatSync(leaf.fd)),
      bytes: outputs[i].bytes,
      sha256: outputs[i].sha256,
    }));
    const record = {
      format: 1,
      producer: "fulcra-radius-scratch-v1",
      attemptId,
      root: rootId,
      attempt: attemptIdActual,
      order,
      revisionDigest: hash(revision),
      outputs: rows,
    };
    if (!recordValid(record, attemptId)) refuse();
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    if (bytes.length > MAX_MANIFEST) refuse();
    const attempt = path.join(root, attemptId);
    const destination = path.join(attempt, MANIFEST);
    const temporary = path.join(attempt, TEMP);
    effect();
    absent(destination);
    const fd = fs.openSync(
      temporary,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const leaf = {
        fd,
        name: temporary,
        id: fileStat(fs.fstatSync(fd)),
        bytes: bytes.length,
        sha256: hash(bytes),
      };
      effect();
      readBound(leaf, MAX_MANIFEST);
      fs.writeFileSync(fd, bytes);
      effect();
      verify(leaf, MAX_MANIFEST);
      fs.fsyncSync(fd);
      for (let i = 0; i < opened.length; i++) {
        effect();
        verify(
          { ...opened[i], id: rows[i].identity, bytes: rows[i].bytes, sha256: rows[i].sha256 },
          MAX_OUTPUTS,
        );
      }
      effect();
      verify(leaf, MAX_MANIFEST);
      absent(destination);
      fs.renameSync(temporary, destination);
      leaf.name = destination;
      effect();
      verify(leaf, MAX_MANIFEST);
      exactLeaves(attempt);
      for (let i = 0; i < opened.length; i++)
        verify(
          { ...opened[i], id: rows[i].identity, bytes: rows[i].bytes, sha256: rows[i].sha256 },
          MAX_OUTPUTS,
        );
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    reserve,
    publish,
    start: (attemptId) => active.add(path.join(root, attemptId)),
    finish: (attemptId) => active.delete(path.join(root, attemptId)),
  };
}

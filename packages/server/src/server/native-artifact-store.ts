import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

export interface NativeArtifactReference {
  dev: number;
  ino: number;
  size: number;
  sha256: string;
  rootDev?: number;
  rootIno?: number;
  parentDev?: number;
  parentIno?: number;
}
const MAX_BYTES = 128 * 1024;
const noFollow = process.platform === "darwin" ? 0x20000000 : fs.constants.O_NOFOLLOW;

/** Private byte storage only. Permanent attempts/aggregate storage are owned by MessageReceipts. */
export class NativeArtifactStore {
  private root?: {
    fd: number;
    parentFd: number;
    dev: number;
    ino: number;
    parentDev: number;
    parentIno: number;
    directory: string;
    parent: string;
  };
  constructor(private readonly directory: string) {}

  private createRoot(authorize: () => void) {
    const parent = fs.realpathSync(path.dirname(this.directory));
    const parentFd = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow,
    );
    let fd: number | undefined;
    try {
      const parentStat = fs.fstatSync(parentFd);
      if (
        !parentStat.isDirectory() ||
        (parentStat.mode & 0o777) !== 0o700 ||
        (process.geteuid && parentStat.uid !== process.geteuid())
      )
        throw new Error("Native artifact parent refused");
      const directory = path.join(parent, path.basename(this.directory));
      try {
        authorize();
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      authorize();
      const before = fs.lstatSync(directory);
      fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow);
      const observed = fs.fstatSync(fd);
      if (
        !observed.isDirectory() ||
        observed.dev !== before.dev ||
        observed.ino !== before.ino ||
        (observed.mode & 0o777) !== 0o700 ||
        (process.geteuid && observed.uid !== process.geteuid())
      )
        throw new Error("Native artifact root refused");
      return {
        fd,
        parentFd,
        dev: observed.dev,
        ino: observed.ino,
        parentDev: parentStat.dev,
        parentIno: parentStat.ino,
        directory,
        parent,
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      fs.closeSync(parentFd);
      throw error;
    }
  }

  private requireRoot(authorize: () => void) {
    authorize();
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("Native artifact confinement unavailable");
    this.root ??= this.createRoot(authorize);
    const root = this.root;
    const current = fs.lstatSync(root.directory),
      parent = fs.lstatSync(root.parent);
    const retained = fs.fstatSync(root.fd),
      retainedParent = fs.fstatSync(root.parentFd);
    if (
      !current.isDirectory() ||
      current.dev !== root.dev ||
      current.ino !== root.ino ||
      retained.dev !== root.dev ||
      retained.ino !== root.ino ||
      retained.nlink === 0 ||
      parent.dev !== root.parentDev ||
      parent.ino !== root.parentIno ||
      retainedParent.dev !== root.parentDev ||
      retainedParent.ino !== root.parentIno ||
      (parent.mode & 0o777) !== 0o700 ||
      (process.geteuid && parent.uid !== process.geteuid()) ||
      (current.mode & 0o777) !== 0o700 ||
      (process.geteuid && current.uid !== process.geteuid())
    )
      throw new Error("Native artifact root changed");
    authorize();
    return root;
  }
  private location(id: string, authorize: () => void) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Native artifact identity refused");
    const root = this.requireRoot(authorize);
    return {
      root,
      file:
        process.platform === "linux"
          ? `/proc/self/fd/${root.fd}/${id}.blob`
          : path.join(root.directory, `${id}.blob`),
    };
  }
  private requireReferenceRoot(
    reference: NativeArtifactReference,
    root: NonNullable<NativeArtifactStore["root"]>,
  ) {
    if (
      reference.rootDev !== root.dev ||
      reference.rootIno !== root.ino ||
      reference.parentDev !== root.parentDev ||
      reference.parentIno !== root.parentIno
    )
      throw new Error("Committed native artifact root proof changed or unavailable");
  }
  /** Recovery never adopts bytes without a permanent ledger reservation. */
  validateReservations(
    reservations: readonly { id: string; size: number; reference?: NativeArtifactReference }[],
    authorize: () => void,
  ): void {
    const root = this.requireRoot(authorize);
    const expected = new Map(reservations.map((item) => [`${item.id}.blob`, item]));
    const present = new Set<string>();
    authorize();
    for (const name of fs.readdirSync(root.directory)) {
      const reservation = expected.get(name);
      if (!reservation) throw new Error("Unreserved native artifact storage refused");
      const { file } = this.location(reservation.id, authorize);
      authorize();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
      try {
        this.requireRoot(authorize);
        const stat = fs.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > reservation.size ||
          (stat.mode & 0o777) !== 0o600 ||
          (process.geteuid && stat.uid !== process.geteuid())
        )
          throw new Error("Native artifact storage reservation changed");
        const reference = reservation.reference;
        if (reference?.rootDev !== undefined) this.requireReferenceRoot(reference, root);
        if (
          reference &&
          (stat.dev !== reference.dev || stat.ino !== reference.ino || stat.size !== reference.size)
        )
          throw new Error("Committed native artifact storage changed");
        present.add(name);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (reservations.some((item) => item.reference && !present.has(`${item.id}.blob`)))
      throw new Error("Committed native artifact storage missing");
    this.requireRoot(authorize);
  }
  /** Caller MUST durably reserve the exact attempt and all bytes before calling this effect. */
  write(id: string, bytes: Uint8Array, authorize: () => void): NativeArtifactReference {
    const snapshot = Buffer.from(bytes);
    if (snapshot.length < 1 || snapshot.length > MAX_BYTES)
      throw new Error("Native artifact size refused");
    const { root, file } = this.location(id, authorize);
    authorize();
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    try {
      this.requireRoot(authorize);
      const before = fs.fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== 0 ||
        (before.mode & 0o777) !== 0o600
      )
        throw new Error("Native artifact destination refused");
      authorize();
      fs.writeFileSync(fd, snapshot);
      authorize();
      fs.fsyncSync(fd);
      authorize();
      fs.fsyncSync(root.fd);
      this.requireRoot(authorize);
      const after = fs.fstatSync(fd);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.nlink !== 1 ||
        after.size !== snapshot.length
      )
        throw new Error("Native artifact write changed");
      return {
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        sha256: createHash("sha256").update(snapshot).digest("hex"),
        rootDev: root.dev,
        rootIno: root.ino,
        parentDev: root.parentDev,
        parentIno: root.parentIno,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  /** No path routing, token fallback or content authority is supplied by this storage adapter. */
  read(id: string, expected: NativeArtifactReference, authorize: () => void): Buffer {
    const { root, file } = this.location(id, authorize);
    this.requireReferenceRoot(expected, root);
    authorize();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow);
    try {
      this.requireRoot(authorize);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.size !== expected.size ||
        stat.size < 1 ||
        stat.size > MAX_BYTES ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error("Native artifact reference changed");
      const bytes = Buffer.alloc(stat.size);
      authorize();
      if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
        throw new Error("Native artifact read incomplete");
      this.requireRoot(authorize);
      if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
        throw new Error("Native artifact content changed");
      authorize();
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  }
}

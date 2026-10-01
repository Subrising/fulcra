import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRadiusProvenance } from "./radius-scratch-provenance.mjs";
import { radiusScratchFiles } from "../shared/cc/radius-workflow.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const refused = () => {
  throw new Error("Radius scratch simulation is unavailable or refused.");
};
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function directory(root) {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    refused();
  return stat;
}

function privateFile(stat) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    refused();
  return stat;
}
function boundFile(output) {
  const descriptor = privateFile(fs.fstatSync(output.fd));
  // lstat observes the named leaf without following a replacement symlink.
  const named = privateFile(fs.lstatSync(output.name));
  if (!same(output.stat, descriptor) || !same(descriptor, named)) refused();
}

// The registration owner injects a fixed private root and the ORIGINAL physical
// owner/lifetime check. No wire field can select a path or supply this guard.
export function createRadiusScratch({ root, assertCurrentOwner, assertCurrentPruneOwner }) {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    typeof assertCurrentOwner !== "function"
  )
    refused();
  const guard = () => {
    const result = assertCurrentOwner();
    if (result && typeof result.then === "function") refused();
  };
  const provenance = createRadiusProvenance({ root, assertCurrentOwner, assertCurrentPruneOwner });
  return {
    simulate(input) {
      if (
        !input ||
        Object.keys(input).sort().join(",") !== "attemptId,expectedRevision,plan" ||
        !UUID.test(input.attemptId)
      )
        refused();
      const files = radiusScratchFiles(input.plan, input.expectedRevision);
      guard();
      if (fs.realpathSync(path.dirname(root)) !== path.dirname(root)) refused();
      // The parent must already exist; never recursively create caller-selected ancestors.
      if (!fs.existsSync(root)) {
        guard();
        fs.mkdirSync(root, { mode: 0o700 });
      }
      const rootStat = directory(root);
      const check = () => {
        guard();
        if (!same(rootStat, directory(root))) refused();
      };
      provenance.reserve(rootStat, input.attemptId);
      const attempt = path.join(root, input.attemptId);
      // Exclusive creation consumes the attempt while its directory is retained, including failures.
      // Directory-entry persistence across crash/power loss is not established here.
      check();
      fs.mkdirSync(attempt, { mode: 0o700 });
      const attemptStat = directory(attempt);
      const effect = () => {
        check();
        if (!same(attemptStat, directory(attempt))) refused();
      };
      const outputs = [];
      const opened = [];
      provenance.start(input.attemptId);
      try {
        for (const [file, text] of Object.entries(files)) {
          effect();
          const name = path.join(attempt, file);
          const fd = fs.openSync(
            name,
            fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_NOFOLLOW,
            0o600,
          );
          const output = { fd, name, stat: null };
          // Retain every descriptor through final publication; close on all exits.
          opened.push(output);
          output.stat = privateFile(fs.fstatSync(fd));
          effect();
          boundFile(output);
          fs.writeFileSync(fd, text, "utf8");
          effect();
          boundFile(output);
          fs.fsyncSync(fd);
          effect();
          boundFile(output);
          const bytes = Buffer.alloc(Buffer.byteLength(text));
          if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) refused();
          if (!bytes.equals(Buffer.from(text))) refused();
          outputs.push({
            file,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
        effect();
        for (const output of opened) boundFile(output);
        provenance.publish({
          rootStat,
          attemptStat,
          attemptId: input.attemptId,
          revision: input.plan.revision,
          opened,
          outputs,
          effect,
        });
        return {
          attemptId: input.attemptId,
          kind: "local-scratch-simulation",
          target: "0.61.x",
          outputs,
          nativeCompilation: "not_run",
          environmentDeployment: "held",
          externalEffects: false,
        };
      } finally {
        for (const output of opened) fs.closeSync(output.fd);
        provenance.finish(input.attemptId);
      }
    },
  };
}

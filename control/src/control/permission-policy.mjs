import { automaticMode, automaticPermissionProof } from "./automatic-permission.mjs";
import { portable } from "../portable-config.mjs";
import fs from "node:fs";
import { ownedByMe, privateOwned } from "../../orca-organization/server/owned.mjs";
import path from "node:path";
import { createHash } from "node:crypto";
export const TASK_ROOT = portable.controller + "/tasks";
// Cutover (A3): the owned task roots are an explicit list. <ORCA_HOME>/tasks always; further roots only from the owner-only
// <ORCA_HOME>/task-roots.json (written by the migration: the legacy controller's tasks directory, whose running sessions keep
// their cwd). Each listed root must be an existing canonical directory this user owns. A file that fails any check extends
// nothing: the check stays at <ORCA_HOME>/tasks and refuses, it never widens. Job folders are still checked by ownedRoot.
export function taskRoots(home = portable.controller) {
  const own = path.join(home, "tasks"),
    file = path.join(home, "task-roots.json");
  if (!fs.existsSync(file)) return Object.freeze([own]);
  try {
    if (fs.realpathSync(file) !== file) throw Error("path changed");
    const s = fs.lstatSync(file);
    if (!s.isFile() || !privateOwned(s, file) || s.size > 4096)
      throw Error("private bounded file required");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !value ||
      Object.keys(value).sort().join() !== "roots,version" ||
      value.version !== 1 ||
      !Array.isArray(value.roots) ||
      value.roots.length > 8
    )
      throw Error("invalid shape");
    const roots = [own];
    for (const root of value.roots) {
      if (
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        path.normalize(root) !== root ||
        root.endsWith("/") ||
        fs.realpathSync(root) !== root
      )
        throw Error("canonical absolute root required");
      const d = fs.statSync(root);
      if (!d.isDirectory() || !ownedByMe(d, root)) throw Error("owned directory required");
      if (!roots.includes(root)) roots.push(root);
    }
    return Object.freeze(roots);
  } catch (e) {
    console.error(
      "Orca task roots: " + file + " refused (" + e.message + "); only " + own + " is owned",
    );
    return Object.freeze([own]);
  }
}
export const TASK_ROOTS = taskRoots();
export const LIMIT = 262144;
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  return Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sort(value[k])]),
        )
      : value;
}
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function ownedRoot(root, base = TASK_ROOTS) {
  if (
    !(Array.isArray(base) ? base : [base]).includes(path.dirname(root)) ||
    !/^[a-f0-9-]{36}$/.test(path.basename(root)) ||
    fs.realpathSync(root) !== root ||
    !fs.statSync(root).isDirectory()
  )
    throw Error("Unique canonical owned task folder required");
  return root;
}
function regular(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT)
      throw Error("Single-link regular file within size limit required");
    const data = Buffer.alloc(LIMIT + 1),
      size = fs.readSync(fd, data, 0, data.length, 0),
      after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      size !== before.size ||
      after.size !== size ||
      before.mtimeMs !== after.mtimeMs ||
      after.nlink !== 1 ||
      named.nlink !== 1 ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw Error("File changed during policy inspection");
    return data.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}
function artifactDeclaration(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 4096)
    throw Error("Bounded artifact manifest required");
  let integerVersion = false;
  const value = JSON.parse(content, (key, value, context) => {
      if (key === "version") integerVersion = context.source === "1";
      return value;
    }),
    names = new Set();
  if (
    !value ||
    Object.keys(value).sort().join() !== "files,version" ||
    value.version !== 1 ||
    !integerVersion ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 8
  )
    throw Error("Invalid artifact manifest");
  for (const item of value.files) {
    if (
      !item ||
      Object.keys(item).sort().join() !== "path,sha256" ||
      typeof item.path !== "string" ||
      item.path.match(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/)?.[0] !== item.path ||
      typeof item.sha256 !== "string" ||
      item.sha256.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      names.has(item.path.toLowerCase())
    )
      throw Error("Invalid or duplicate artifact declaration");
    names.add(item.path.toLowerCase());
  }
}
function parents(file, root, manifest) {
  const relative = path.relative(root, file);
  if (
    !path.isAbsolute(file) ||
    path.normalize(file) !== file ||
    !relative ||
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    (relative.split("/").some((p) => !p || p.startsWith(".")) &&
      !(manifest && relative === ".orca-artifacts.json"))
  )
    throw Error("Path outside routine owned-file scope");
  const result = [];
  for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
    if (fs.realpathSync(folder) !== folder) throw Error("Symlink path refused");
    const s = fs.lstatSync(folder);
    if (!s.isDirectory()) throw Error("Existing directory required");
    result.push({ path: folder, dev: s.dev, ino: s.ino });
    if (folder === root) return result;
  }
}
export function evaluatePermission(request, root, base = TASK_ROOTS, modeId = null) {
  if (automaticMode(request.provider, modeId))
    return automaticPermissionProof(request, root, modeId, digest(canonical(request.input ?? {})));
  ownedRoot(root, base);
  if (
    Buffer.byteLength(canonical(request)) > 1048576 ||
    request.provider !== "claude" ||
    request.kind !== "tool" ||
    !["Write", "Edit"].includes(request.name) ||
    typeof request.metadata?.toolUseId !== "string"
  )
    throw Error("Only correlated Claude Write/Edit tools are routine");
  const input = request.input,
    keys = Object.keys(input ?? {})
      .sort()
      .join();
  if (
    !input ||
    typeof input.file_path !== "string" ||
    (request.name === "Write"
      ? keys !== "content,file_path"
      : ![
          "file_path,new_string,old_string",
          "file_path,new_string,old_string,replace_all",
        ].includes(keys))
  )
    throw Error("Unknown tool input fields");
  const manifest =
    request.name === "Write" && input.file_path === path.join(root, ".orca-artifacts.json");
  if (manifest) artifactDeclaration(input.content);
  const chain = parents(input.file_path, root, manifest);
  let existing = null;
  try {
    existing = regular(input.file_path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let output;
  if (request.name === "Write") {
    if (typeof input.content !== "string") throw Error("Text content required");
    output = input.content;
  } else {
    if (
      !existing ||
      typeof input.old_string !== "string" ||
      !input.old_string ||
      typeof input.new_string !== "string" ||
      (input.replace_all !== undefined && input.replace_all !== false)
    )
      throw Error("One exact edit required");
    const text = existing.toString("utf8");
    if (!Buffer.from(text).equals(existing) || text.split(input.old_string).length !== 2)
      throw Error("Edit must match exactly once in a UTF-8 file");
    output = text.replace(input.old_string, () => input.new_string);
  }
  if (Buffer.byteLength(output) > LIMIT || Buffer.byteLength(canonical(input)) > LIMIT)
    throw Error("Routine input or resulting file exceeds size limit");
  return {
    file: input.file_path,
    root,
    parents: chain,
    inputHash: digest(canonical(input)),
    expectedHash: digest(output),
    expectedBytes: Buffer.byteLength(output),
    beforeHash: existing ? digest(existing) : null,
  };
}
// A content mismatch is NOT the same kind of fact as a structural one, and treating them alike is what made
// ordinary work look like tampering.
//
// Every structural check below -- path identity, regular file, single link, no symlink, size -- fails only
// if something is wrong in a way the owning agent could not bring about through the approved surface. Those
// stay plain Errors and remain incidents.
//
// The byte comparison is different. It asks "does the file RIGHT NOW still hold the approved output", which
// is a claim about the present, not about what the approved tool call did. Verification is deferred, so any
// later write to the same owned file -- including the agent's own next edit, which reconcile may have
// declined to approve while this one was unverified -- makes it false. That is a time-of-check window, not
// evidence of tampering, so it is typed separately and the caller decides.
export class OutputSuperseded extends Error {}
export function verifyPermissionOutput(proof) {
  for (const p of proof.parents) {
    const s = fs.lstatSync(p.path);
    if (
      fs.realpathSync(p.path) !== p.path ||
      !s.isDirectory() ||
      s.dev !== p.dev ||
      s.ino !== p.ino
    )
      throw Error("Approved path identity changed");
  }
  const data = regular(proof.file);
  const s = fs.lstatSync(proof.file);
  // Structure is intact and the file is still the owned regular file that was approved; only the bytes moved
  // on. The observed digest travels with the error so the caller can record what IS on disk.
  if (data.length !== proof.expectedBytes || digest(data) !== proof.expectedHash) {
    throw Object.assign(new OutputSuperseded("Tool output differs from approved content"), {
      observed: {
        file: proof.file,
        sha256: digest(data),
        bytes: data.length,
        dev: s.dev,
        ino: s.ino,
        links: s.nlink,
      },
    });
  }
  return {
    file: proof.file,
    sha256: digest(data),
    bytes: data.length,
    dev: s.dev,
    ino: s.ino,
    links: s.nlink,
  };
}

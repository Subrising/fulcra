import { runGitCommandBytes } from "./run-git-command.js";

// Match the existing git-show ceiling. Oversized batches use bounded per-file reads.
const MAX_CONTENT_BYTES = 20 * 1024 * 1024;

/** Null means the batch cannot preserve per-file read semantics within its budget. */
export async function readGitFileContents(
  cwd: string,
  specs: string[],
): Promise<Map<string, string | null> | null> {
  const unique = [...new Set(specs)];
  if (unique.length === 0) return new Map();
  // The line-based batch protocol cannot represent embedded newlines.
  if (unique.some((spec) => spec.includes("\n"))) return null;
  const result = await runGitCommandBytes(["cat-file", "--batch"], {
    cwd,
    input: unique.join("\n") + "\n",
    envOverlay: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxOutputBytes: MAX_CONTENT_BYTES,
  });
  if (result.truncated) return null;
  const contents = new Map<string, string | null>();
  let offset = 0;
  for (const spec of unique) {
    const end = result.stdout.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete git object header");
    const header = result.stdout.subarray(offset, end).toString("utf8");
    offset = end + 1;
    if (header === `${spec} missing`) {
      contents.set(spec, null);
      continue;
    }
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header);
    // Submodules and other non-blob objects retain git-show behavior.
    if (!match) return null;
    const size = Number(match[1]);
    if (
      !Number.isSafeInteger(size) ||
      offset + size >= result.stdout.length ||
      result.stdout[offset + size] !== 10
    )
      throw new Error("Invalid git object length");
    contents.set(spec, result.stdout.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  if (offset !== result.stdout.length) throw new Error("Unexpected git object output");
  return contents;
}

/**
 * One blob's exact bytes by object id (`git cat-file blob <id>`), for callers that must keep binary
 * content intact; readGitFileContents decodes as UTF-8. Null when the blob exceeds `maxBytes`.
 */
export async function readGitBlobBytes(
  cwd: string,
  objectId: string,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(objectId)) throw new Error("Invalid object id");
  const result = await runGitCommandBytes(["cat-file", "blob", objectId], {
    cwd,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxOutputBytes: maxBytes + 1,
  });
  if (result.truncated || result.stdout.length > maxBytes) return null;
  return result.stdout;
}

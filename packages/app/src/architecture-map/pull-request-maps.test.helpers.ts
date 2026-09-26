import {
  mapTextAtCommit,
  pullRequestReadable,
  type FileAtCommitAnswer,
  type PullRequestMaps,
} from "./architecture-change";

// A pull request's Before/After are the maps at its own commits: the forge's
// base and head commits, read through the host's `checkout.file-at-commit.get`. Tests build their
// changes the same way, with a fake host that answers from the committed texts it was given.
export const BASE_COMMIT = "1111111111111111111111111111111111111111";
export const HEAD_COMMIT = "2222222222222222222222222222222222222222";

type At = { kind: "commit"; sha: string } | { kind: "merge-base"; of: [string, string] };

/** A fake `checkout.file-at-commit.get`: the merge base answers `baseText`, the head `headText`. */
export function fakeFileAtCommit(baseText: string | null, headText: string | null) {
  return (at: At): FileAtCommitAnswer => {
    const text =
      at.kind === "merge-base" && at.of[0] === BASE_COMMIT && at.of[1] === HEAD_COMMIT
        ? baseText
        : at.kind === "commit" && at.sha === HEAD_COMMIT
          ? headText
          : undefined;
    if (text === undefined) return { status: "error", encoding: "none", error: "unknown commit" };
    if (text === null) return { status: "missing", encoding: "none" };
    return { status: "ok", encoding: "utf-8", content: text };
  };
}

/** The maps as the app reads them for a pull request, on a host that can read at a commit. */
export function pullRequestMaps(baseText: string | null, headText: string | null): PullRequestMaps {
  const commits = pullRequestReadable(true, { baseRefOid: BASE_COMMIT, headRefOid: HEAD_COMMIT });
  if (commits === null) throw new Error("the fixture commits are not readable");
  const read = fakeFileAtCommit(baseText, headText);
  const before = mapTextAtCommit(read({ kind: "merge-base", of: [commits.base, commits.head] }));
  const after = mapTextAtCommit(read({ kind: "commit", sha: commits.head }));
  if (before.kind === "unavailable") return before;
  if (after.kind === "unavailable") return after;
  return { kind: "ok", base: before.text, head: after.text };
}

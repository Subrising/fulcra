import path from "node:path";
import type {
  CheckoutFileAtCommitGetRequest,
  CheckoutFileAtCommitGetResponse,
} from "@getpaseo/protocol/messages";
import { FileAtCommitInputError, readFileAtCommit } from "../../utils/git-file-at-commit.js";
import { expandTilde } from "../../utils/path.js";

// `checkout.file-at-commit.get` (CONTRACTS v1.16). The cwd must be the directory of a workspace this
// daemon serves (its registry), not any folder on disk; then the read is `git cat-file` /
// `git merge-base` only (utils/git-file-at-commit.ts).

type Payload = CheckoutFileAtCommitGetResponse["payload"];

export async function handleFileAtCommitRequest(input: {
  msg: CheckoutFileAtCommitGetRequest;
  listWorkspaceCwds: () => Promise<string[]>;
  read?: typeof readFileAtCommit;
}): Promise<Payload> {
  const { msg } = input;
  const base = { requestId: msg.requestId, cwd: msg.cwd, path: msg.path };
  const refused = (error: string): Payload => ({
    ...base,
    commit: null,
    status: "error",
    encoding: "none",
    error,
  });
  const requested = msg.cwd.trim();
  if (!requested) return refused("cwd is required");
  const resolved = path.resolve(expandTilde(requested));
  const served = (await input.listWorkspaceCwds()).some(
    (cwd) => path.resolve(expandTilde(cwd)) === resolved,
  );
  if (!served) return refused("This folder is not a workspace this host serves");
  try {
    const result = await (input.read ?? readFileAtCommit)({
      cwd: resolved,
      at: msg.at,
      path: msg.path,
      maxBytes: msg.maxBytes,
    });
    return { ...base, ...result };
  } catch (error) {
    // Validation messages are the host's own; anything else stays generic.
    return refused(
      error instanceof FileAtCommitInputError ? error.message : "The file could not be read",
    );
  }
}

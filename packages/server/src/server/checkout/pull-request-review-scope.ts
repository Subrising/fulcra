import path from "node:path";
import { expandTilde } from "../../utils/path.js";

// The checks every `checkout.pull-request-review.*` request makes before reading anything: the folder is a
// workspace this host serves, and commits are full ids.

export const SHA40 = /^[0-9a-f]{40}$/;

export const NOT_SERVED = "This folder is not a workspace this host serves";

export async function servedCwd(
  cwd: string,
  deps: { listWorkspaceCwds: () => Promise<string[]> },
): Promise<string | null> {
  const requested = cwd.trim();
  if (!requested) return null;
  const resolved = path.resolve(expandTilde(requested));
  const served = (await deps.listWorkspaceCwds()).some(
    (known) => path.resolve(expandTilde(known)) === resolved,
  );
  return served ? resolved : null;
}

import { localMachine, localJson } from "../src/local-machine.mjs";
// Read-only host discovery accepts exactly the two reviewed cutover pairings.
// The owner uid remains trusted; file modes cannot isolate same-uid processes.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ownedChild, connectOwnedDaemon } from "../orca-ingress/src/management-client.mjs";
function ownedFile(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o022 || fs.realpathSync(file) !== file)
    throw Error("Pinned activation file ownership changed");
  return fs.readFileSync(file);
}
export async function verifyKnownActivation(activeFile, releases) {
  const active = JSON.parse(ownedFile(activeFile));
  const matches = releases.filter((r) => r.guard === active.guard?.sha256);
  if (matches.length !== 1) throw Error("Unknown or ambiguous activation release");
  const selected = matches[0];
  if (!Object.hasOwn(selected.files, selected.entry))
    throw Error("Activation entrypoint is not pinned");
  for (const [file, expected] of Object.entries(selected.files)) {
    if (createHash("sha256").update(ownedFile(file)).digest("hex") !== expected)
      throw Error("Pinned activation closure changed");
  }
  // The verifier checks the live PID/birth, loaded guard and actual module bytes again.
  // A failed selected verifier never falls back to a different release.
  return (await import(pathToFileURL(selected.entry).href)).verifyActivation();
}
const releases = localJson("activation-releases.json", []);
// Cutover A2 (f): the owned-daemon equivalent of the legacy activation probe. The V4 daemon verifies its own bundled
// distribution (trusted plugin identity, owned child, boot/epoch handshake); what a same-user client can and must check is
// that THIS daemon admits the owner session, serves the verified plugin's management context, and reports the owned
// controller ready over its channel: organization.manage {action:'health'} -> controller-status 'ready' + a health round trip.
export async function verifyOwnedActivation({ connect = connectOwnedDaemon } = {}) {
  const session = await connect();
  try {
    const reply = await session.invoke("organization.manage", { action: "health" });
    if (reply?.status !== "observed")
      throw Error(
        "Owned controller not verified: " + String(reply?.message ?? "no reply").slice(0, 200),
      );
    return { topology: "owned-child", observedAt: reply.observedAt ?? null };
  } finally {
    await Promise.resolve()
      .then(() => session.close())
      .catch(() => {});
  }
}
const verifyLegacyActivation = () =>
  verifyKnownActivation(localMachine("legacyActivationSelector"), releases);
export const verifyMiniActivation = (
  env = process.env,
  { owned = verifyOwnedActivation, legacy = verifyLegacyActivation } = {},
) => (ownedChild(env) ? owned() : legacy());

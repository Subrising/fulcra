// U7 accounts.manage (control side). Account management -- list, switch a session, set the default, take a chat over
// onto another account, add/remove/rename an account, pool settings -- needs the host's `accountsManage` for this
// invocation. The host sets it for this Mac's owner, and for a paired device only while the owner has explicitly
// granted that device accounts.manage (never on the read tier, never implied by the Command Centre grant). Only the
// host's own flags decide: the plugin's declared read flag is ignored here, since the owner's reads are declared too.
// A host that predates the capability (no recordAccountAction) keeps the old rule: the local owner only.
import { currentManagement } from "./management-context.mjs";

export const askOwner = (host) =>
  `Ask the owner to allow account management for this device on ${host || "the Mac that runs this host"}`;
export function accountAuthority(management = currentManagement()) {
  const m = management,
    device = m?.principal?.authentication === "paired-device";
  if (!m || m.readOnly === true) return { allowed: false, remote: device };
  if (m.accountsManage === true) return { allowed: true, remote: device };
  if (typeof m.recordAccountAction !== "function" && m.principal && !device)
    return { allowed: true, remote: false };
  return { allowed: false, remote: device };
}
// Records a remote account action for the owner (the host adds the device and the time). Local-owner actions are not
// recorded. Only the action and the account's label cross: never a credential.
export async function recordAccountAction(entry, management = currentManagement()) {
  if (typeof management?.recordAccountAction !== "function") return { recorded: false };
  return management.recordAccountAction({
    action: entry.action,
    accountLabel: String(entry.accountLabel).slice(0, 80),
  });
}

// Local owners administer accounts. Paired devices can only list and switch the host-bound viewed session.
import { currentManagement } from "./management-context.mjs";

export const askOwner = (_host) => "Account settings require the local owner on the host Mac.";
export function accountAuthority(management = currentManagement(), sessionId) {
  const m = management,
    device = m?.principal?.authentication === "paired-device";
  if (!m || m.readOnly === true) return { allowed: false, remote: device };
  if (m.principal?.accountSessionId !== undefined)
    return {
      allowed: device && !!sessionId && m.principal.accountSessionId === sessionId,
      remote: device,
    };
  if (device) return { allowed: false, remote: true };
  if (m.accountsManage === true) return { allowed: true, remote: device };
  if (typeof m.recordAccountAction !== "function" && m.principal && !device)
    return { allowed: true, remote: false };
  return { allowed: false, remote: device };
}
export const accountSessionScope = () => currentManagement()?.principal?.accountSessionId;
// Records a remote account action for the owner (the host adds the device and the time). Local-owner actions are not
// recorded. Only the action and the account's label cross: never a credential.
export async function recordAccountAction(entry, management = currentManagement()) {
  if (typeof management?.recordAccountAction !== "function") return { recorded: false };
  return management.recordAccountAction({
    action: entry.action,
    accountLabel: String(entry.accountLabel).slice(0, 80),
  });
}

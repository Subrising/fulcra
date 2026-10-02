// Cutover A2: a management WRITE must carry the host's per-call principal, holding command-centre.manage AND
// daemon.manage -- the host's own management rule (a paired device never holds them). Defence in depth: the host already
// refuses anything else; the controller refuses it too, before dispatch (distribution-child) and at dispatch (rpc.mjs).
export function requireManagementPrincipal(p) {
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.id !== "string" ||
    !p.id ||
    p.id.length > 512 ||
    !["daemon-password", "paired-device", "protected-local-ipc"].includes(p.authentication) ||
    (p.authentication === "paired-device" && (typeof p.deviceId !== "string" || !p.deviceId)) ||
    !Array.isArray(p.permissions) ||
    !p.permissions.includes("command-centre.manage") ||
    !p.permissions.includes("daemon.manage")
  )
    throw Object.assign(
      Error("Management principal refused: command-centre.manage and daemon.manage are required"),
      { code: "unauthorised" },
    );
  return p;
}

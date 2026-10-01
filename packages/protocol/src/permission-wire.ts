import type { DaemonPermission, WSOutboundMessage } from "./messages.js";

// Permissions added after the legacy clients' closed permission enum: a client without the capability would reject
// the whole message, so it never sees them (U7 adds accounts.manage beside command-centre.manage).
const NOT_IN_LEGACY_ENUM: ReadonlySet<DaemonPermission> = new Set<DaemonPermission>([
  "command-centre.manage",
  "accounts.manage",
]);

/** Wire presentation only; never use this filtered list for host authorization. */
export function permissionsForWire(
  permissions: readonly DaemonPermission[],
  capable: boolean,
): DaemonPermission[] {
  return permissions.filter((permission) => capable || !NOT_IN_LEGACY_ENUM.has(permission));
}

export function permissionMessageForWire(
  message: WSOutboundMessage,
  capable: boolean,
): WSOutboundMessage {
  if (capable || message.type !== "session") return message;
  const inner = message.message;
  if (inner.type === "status" && inner.payload.status === "server_info") {
    const permissions = inner.payload.permissions;
    if (!Array.isArray(permissions)) return message;
    return {
      ...message,
      message: {
        ...inner,
        payload: { ...inner.payload, permissions: permissionsForWire(permissions, false) },
      },
    };
  }
  switch (inner.type) {
    case "hub.management.daemon.connect.response":
    case "hub.management.daemon.get_status.response":
    case "hub.management.daemon.disconnect.response":
    case "hub.management.daemon.permissions.update.response":
      return {
        ...message,
        message: {
          ...inner,
          payload: {
            ...inner.payload,
            status: {
              ...inner.payload.status,
              permissions: permissionsForWire(inner.payload.status.permissions, false),
            },
          },
        },
      };
    default:
      return message;
  }
}

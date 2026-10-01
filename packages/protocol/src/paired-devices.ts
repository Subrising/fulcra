import { z } from "zod";
export const ListPairedDevicesRequestSchema = z.object({
  type: z.literal("daemon.list_paired_devices.request"),
  requestId: z.string(),
});
export const RevokePairedDeviceRequestSchema = z.object({
  type: z.literal("daemon.revoke_paired_device.request"),
  requestId: z.string(),
  deviceId: z.string(),
});
export const UnpairSelfRequestSchema = z.object({
  type: z.literal("daemon.unpair_self.request"),
  requestId: z.string(),
});
export const SetRelayEndpointRequestSchema = z.object({
  type: z.literal("daemon.set_relay_endpoint.request"),
  requestId: z.string(),
  endpoint: z.string().nullable(),
  useTls: z.boolean().optional(),
});
export const ListPairedDevicesResponseSchema = z.object({
  type: z.literal("daemon.list_paired_devices.response"),
  payload: z.object({
    requestId: z.string(),
    devices: z.array(
      z.object({
        deviceId: z.string(),
        name: z.string(),
        createdAt: z.string(),
        lastSeenAt: z.string().nullable(),
        connected: z.boolean(),
        // COMPAT(pairingInvites): added 2026-09-29; older daemons omit it (no device may invite).
        invites: z.boolean().optional(),
        // COMPAT(deviceCommandCentre): added 2026-09-29; older daemons omit it (no device has Command Centre).
        commandCentre: z.boolean().optional(),
        // D13: Command Centre granted read-only (reads only, enforced by the daemon).
        readOnly: z.boolean().optional(),
        // U7: this Mac's owner allowed the device to manage accounts (accounts.manage). Older daemons omit it.
        accountsManage: z.boolean().optional(),
      }),
    ),
  }),
});
export const RevokePairedDeviceResponseSchema = z.object({
  type: z.literal("daemon.revoke_paired_device.response"),
  payload: z.object({ requestId: z.string() }),
});
export const UnpairSelfResponseSchema = z.object({
  type: z.literal("daemon.unpair_self.response"),
  payload: z.object({ requestId: z.string() }),
});
export const SetRelayEndpointResponseSchema = z.object({
  type: z.literal("daemon.set_relay_endpoint.response"),
  payload: z.object({ requestId: z.string(), endpoint: z.string().nullable() }),
});

// Pair once, see every Mac. A device this Mac's owner allowed (see the allow request) may ask for a fresh,
// single-use, short-lived pairing offer for ANOTHER device, so an app already paired with several Macs can hand a
// new device one bundle of offers. No credential moves between hosts: each offer is minted by the host it admits
// to, and the new device claims each with its own key.
export const PairingInviteRequestSchema = z.object({
  type: z.literal("daemon.pairing.invite.request"),
  requestId: z.string(),
});
export const PairingInviteResponseSchema = z.object({
  type: z.literal("daemon.pairing.invite.response"),
  payload: z.object({ requestId: z.string(), url: z.string(), expiresAt: z.string() }),
});
// Local owner only: allow or stop a paired device from inviting new devices to this Mac.
export const PairingInviteAllowRequestSchema = z.object({
  type: z.literal("daemon.pairing.invite.allow.request"),
  requestId: z.string(),
  deviceId: z.string(),
  allow: z.boolean(),
});
// L46 option 5, local owner only: allow or stop a paired device using Command Centre over the relay. Off unless set
// here; never set at pairing.
export const PairingCommandCentreAllowRequestSchema = z.object({
  type: z.literal("daemon.pairing.command_centre.allow.request"),
  requestId: z.string(),
  deviceId: z.string(),
  allow: z.boolean(),
  // D13: the read-only tier -- the device may call Command Centre's reads and nothing else, enforced by the daemon.
  // Send it only to a daemon advertising features.deviceReadOnlyTier: an older daemon ignores the field.
  readOnly: z.boolean().optional(),
});
export const PairingCommandCentreAllowResponseSchema = z.object({
  type: z.literal("daemon.pairing.command_centre.allow.response"),
  payload: z.object({
    requestId: z.string(),
    deviceId: z.string(),
    allow: z.boolean(),
    readOnly: z.boolean().optional(),
  }),
});
export const PairingInviteAllowResponseSchema = z.object({
  type: z.literal("daemon.pairing.invite.allow.response"),
  payload: z.object({ requestId: z.string(), deviceId: z.string(), allow: z.boolean() }),
});

// U7, local owner only: allow or stop a paired device managing accounts (list, switch, set the default, take over a
// chat onto another account). A separate grant: never implied by Command Centre, never on the read-only tier, never
// set at pairing. Send it only to a daemon advertising features.deviceAccountsManage.
export const PairingAccountsManageAllowRequestSchema = z.object({
  type: z.literal("daemon.pairing.accounts_manage.allow.request"),
  requestId: z.string(),
  deviceId: z.string(),
  allow: z.boolean(),
});
export const PairingAccountsManageAllowResponseSchema = z.object({
  type: z.literal("daemon.pairing.accounts_manage.allow.response"),
  payload: z.object({ requestId: z.string(), deviceId: z.string(), allow: z.boolean() }),
});
// U7, local owner only: the recent account actions paired devices made (device, action, account label, time). Labels
// only; never a credential.
export const AccountsAuditListRequestSchema = z.object({
  type: z.literal("daemon.accounts_audit.list.request"),
  requestId: z.string(),
});
export const AccountsAuditListResponseSchema = z.object({
  type: z.literal("daemon.accounts_audit.list.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(
      z.object({
        at: z.string(),
        deviceId: z.string(),
        deviceName: z.string().nullable(),
        action: z.string(),
        accountLabel: z.string(),
      }),
    ),
  }),
});

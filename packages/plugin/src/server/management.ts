import type { JsonValue } from "@getpaseo/protocol/trusted-input";
import type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
} from "@getpaseo/protocol/controller-management";
export type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
} from "@getpaseo/protocol/controller-management";
export interface PluginManagementContextV11 {
  readonly contract: "1.1";
  readonly principal: ManagementPrincipalV11;
  /** D13: the host opened this invocation for a read-only device; only reads will succeed. */
  readonly readOnly?: boolean;
  /**
   * U7: the caller may manage accounts (list, switch, set the default, take over a chat onto another account). Set by
   * the host only for this Mac's owner, or a paired device the owner explicitly granted `accounts.manage`; never on
   * the read-only tier. Absent means refuse account changes.
   */
  readonly accountsManage?: boolean;
  /**
   * U7: records a remote account action for the owner's audit (Settings > Devices). The host adds the device and the
   * time from this invocation; the plugin gives only what happened and the account's label (never a credential).
   * Local-owner actions are not recorded (`recorded: false`). Refused without `accountsManage`.
   */
  recordAccountAction(entry: AccountActionV11): Promise<{ recorded: boolean }>;
  invoke(command: ControllerManagementCommandV11): Promise<JsonValue>;
}
export type AccountActionKindV11 =
  | "switch"
  | "set-default"
  | "takeover"
  | "add"
  | "remove"
  | "update"
  | "pool-settings";
export interface AccountActionV11 {
  readonly action: AccountActionKindV11;
  /** The account's display label (at most 80 characters). */
  readonly accountLabel: string;
}
export interface TrustedManagementBridgeV11 {
  register(
    handler: (
      command: ControllerManagementCommandV11,
      principal: ManagementPrincipalV11,
    ) => Promise<JsonValue>,
  ): void;
}
export type PluginHandlerContextV11 = import("./contracts.js").PluginHandlerContext;

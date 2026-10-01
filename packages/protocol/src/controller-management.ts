import type { DaemonPermission } from "./messages.js";
import type { JsonValue, JsonObject, ProvenanceBindingV11 } from "./trusted-input.js";

export interface ControllerManagementCommandV11 {
  readonly method: string;
  readonly input: JsonValue;
}
export interface ManagementPrincipalV11 {
  readonly id: string;
  readonly authentication: "daemon-password" | "paired-device" | "protected-local-ipc";
  readonly deviceId: string | null;
  readonly permissions: readonly DaemonPermission[];
}
export type ControllerHostRequestV11 =
  | {
      readonly id: string;
      readonly epoch: string;
      readonly type: "issue-provenance";
      readonly binding: ProvenanceBindingV11;
    }
  | {
      readonly id: string;
      readonly epoch: string;
      readonly type: "daemon-rpc" | "report-inbox";
      readonly frame: JsonObject;
    };
export type ControllerHostReplyV11 =
  | {
      readonly id: string;
      readonly epoch: string;
      readonly ok: true;
      readonly result: JsonValue;
    }
  | {
      readonly id: string;
      readonly epoch: string;
      readonly ok: false;
      readonly code: "unavailable" | "unauthorised" | "invalid" | "expired" | "uncertain";
      readonly message?: string;
    };
export interface ControllerChildCommandV11 {
  readonly id: string;
  readonly epoch: string;
  readonly type: "management";
  readonly command: ControllerManagementCommandV11;
  readonly principal: ManagementPrincipalV11;
}
export type ControllerChildStateV11 = "disabled" | "starting" | "ready" | "stopping" | "failed";

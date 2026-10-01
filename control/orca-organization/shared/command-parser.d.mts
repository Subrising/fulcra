import type { ControllerManagementCommandV11 } from "@getpaseo/protocol/controller-management";
/** Pure closed method/input validation; child authority checks still run at dispatch. */
export function parseControllerCommand(value: unknown): ControllerManagementCommandV11;
export const MANAGEMENT_METHODS: readonly string[];
export const READ_METHODS: readonly string[];

export const OWNED_CHANNEL_METHODS: readonly string[];

export const NATIVE_OWNER_STATUS_METHODS: readonly string[];

export const NATIVE_OWNER_METHODS: readonly string[];

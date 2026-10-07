// FULCRA(trusted-bundle): identifiers route to the host-selected bundled plugin.
// An identifier or catalog declaration never grants trust, ownership or permissions.
// COMPAT(legacyBundledController): added in v0.2.1; retain while older apps/hosts
// omit the configured identity. The historical runtime ID and private paths stay valid.
export const LEGACY_CONTROLLER_PLUGIN_ID = "orca-organization-next";

type TrustedReports = readonly {
  readonly id: string;
  readonly contract?: "1.1";
  readonly hooks: readonly string[];
}[];

/**
 * The controller a host reports in its catalog's trusted reports: the one V1.1 report carrying the
 * input-admission hook. Null when it reports none (older hosts) or several. Routing only; never a grant.
 */
export function reportedControllerPluginId(reports?: TrustedReports): string | null {
  const own = (reports ?? []).filter((r) => r.contract === "1.1" && r.hooks.includes("input"));
  return own.length === 1 && /^[a-z0-9][a-z0-9-]*$/.test(own[0].id) ? own[0].id : null;
}

/** The reported controller, or the legacy ID for hosts that predate configured identities. */
export function controllerPluginIdFromTrustedReports(reports?: TrustedReports): string {
  return reportedControllerPluginId(reports) ?? LEGACY_CONTROLLER_PLUGIN_ID;
}

export function configuredControllerPluginId(id?: string): string {
  if (id === undefined) return LEGACY_CONTROLLER_PLUGIN_ID;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id))
    throw new Error("Invalid bundled controller identity");
  return id;
}

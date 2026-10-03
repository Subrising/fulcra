// FULCRA(trusted-bundle): identifiers route to the host-selected bundled plugin.
// An identifier or catalog declaration never grants trust, ownership or permissions.
// COMPAT(legacyBundledController): added in v0.2.1; retain while older apps/hosts
// omit the configured identity. The historical runtime ID and private paths stay valid.
export const LEGACY_CONTROLLER_PLUGIN_ID = "orca-organization-next";

export function configuredControllerPluginId(id?: string): string {
  if (id === undefined) return LEGACY_CONTROLLER_PLUGIN_ID;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id))
    throw new Error("Invalid bundled controller identity");
  return id;
}

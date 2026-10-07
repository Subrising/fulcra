// The bundled controller's own plugin ID: the one controller-side copy, equal to
// orca-organization/paseo-plugin.json "id" (plugin-identity.test.mjs checks it). Hosts route to it by their
// configured ID and verify it against the manifest; the ID alone grants nothing.
export const PLUGIN_ID = "orca-organization-next";

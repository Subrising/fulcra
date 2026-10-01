import type { ManagementTarget } from "../management.js";
/** Authority unit-test target. Loader provenance is covered by bundled-runtime tests. */
export const bundledTarget: ManagementTarget = Object.freeze({
  pluginId: "orca-organization-next",
  bundleDirectory: "/fixture/bundle",
  isCurrent: () => true,
});

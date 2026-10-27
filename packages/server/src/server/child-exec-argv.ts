import { packagedInspectorFlags } from "./inspector-flavour.js";

/**
 * Node flags for a Node child that the daemon starts (FU-466). The packaged inspector flags come first, so no
 * child opens an inspector on SIGUSR1 (FU-79). A source (.ts) run adds the loader flags after them. The parent's
 * own execArgv is never inherited.
 */
export function daemonChildExecArgv(moduleUrl: string, loaderUrl: URL): string[] {
  const flags = packagedInspectorFlags().filter((flag) => flag.length > 0);
  if (!moduleUrl.endsWith(".ts")) return flags;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl.href)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    ...flags,
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

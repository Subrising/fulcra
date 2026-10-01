import path from "node:path";
// A complete config avoids electron-builder concatenating inherited resource arrays.
function resourceSource(from, { desktop, pluginOutput, webOutput }) {
  if (from === "bundled-plugins") return path.resolve(pluginOutput);
  if (from === "../app/dist") return path.resolve(webOutput);
  return path.resolve(desktop, from);
}
export function commandCentreBuildConfig(base, outputs) {
  if (base.extends) throw Error("Expected a standalone base builder config");
  return {
    ...base,
    files: base.files.map((item) =>
      typeof item === "string"
        ? item
        : { ...item, from: path.resolve(outputs.desktop, item.from ?? ".") },
    ),
    extraResources: base.extraResources.map((item) => ({
      ...item,
      from: resourceSource(item.from, outputs),
    })),
  };
}

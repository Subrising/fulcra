import path from "node:path";

// Candidate app bundles must not become additional Spotlight entries.
// This selects staging only; installation homes and the installed app stay unchanged.
export function commandCentrePackageOutput(root, env, platform) {
  const output = path.resolve(
    env.FULCRA_PACKAGE_OUTPUT ??
      path.join(root, "packages/desktop", platform === "darwin" ? "release.noindex" : "release"),
  );
  if (platform === "darwin" && !output.split(path.sep).some((part) => part.endsWith(".noindex")))
    throw Error("Mac candidate output must be inside a .noindex directory");
  return output;
}

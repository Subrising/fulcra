// Test-only source-build resolution; never used by the portable release bundle.
import { pathToFileURL } from "node:url";
import path from "node:path";
const clientEntries = new Map([
  ["@getpaseo/client", "index.js"],
  ["@getpaseo/client/internal/daemon-client", "daemon-client.js"],
]);
export async function resolve(specifier, context, next) {
  // Resolve client and protocol from the same selected test product, even when
  // this checkout's ancestor has a different workspace installed.
  if (process.env.FULCRA_TEST_PRODUCT && clientEntries.has(specifier)) {
    return next(
      pathToFileURL(
        path.join(
          process.env.FULCRA_TEST_PRODUCT,
          "packages/client/dist",
          clientEntries.get(specifier),
        ),
      ).href,
      context,
    );
  }
  if (specifier === "@fulcra/test-host") {
    if (!process.env.FULCRA_TEST_HOST) throw Error("FULCRA_TEST_HOST build required");
    return next(pathToFileURL(path.resolve(process.env.FULCRA_TEST_HOST)).href, context);
  }
  if (specifier.startsWith("@getpaseo/protocol/")) {
    if (!process.env.FULCRA_TEST_PRODUCT) throw Error("FULCRA_TEST_PRODUCT build required");
    return next(
      pathToFileURL(
        path.join(
          process.env.FULCRA_TEST_PRODUCT,
          "packages/protocol/dist",
          specifier.slice("@getpaseo/protocol/".length) + ".js",
        ),
      ).href,
      context,
    );
  }
  if (
    process.env.FULCRA_TEST_PRODUCT &&
    context.parentURL === pathToFileURL(path.resolve(process.env.FULCRA_TEST_HOST ?? ".")).href &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.includes(":")
  ) {
    return next(specifier, {
      ...context,
      parentURL: pathToFileURL(
        path.join(process.env.FULCRA_TEST_PRODUCT, "packages/server/package.json"),
      ).href,
    });
  }
  if (
    process.env.FULCRA_TEST_PRODUCT &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.includes(":")
  ) {
    try {
      return await next(specifier, context);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
    // Session pulls optional-provider imports from the server workspace. Resolve
    // their ESM export conditions there, including workspace-local dependencies.
    return next(specifier, {
      ...context,
      parentURL: pathToFileURL(
        path.join(process.env.FULCRA_TEST_PRODUCT, "packages/server/package.json"),
      ).href,
    });
  }
  return next(specifier, context);
}

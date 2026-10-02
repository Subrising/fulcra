/** A Windows controller cannot supply the POSIX ownership proof required by trusted distribution code. */
export function requireTrustedBundleHost(): void {
  if (process.platform === "win32") {
    throw Object.assign(new Error("Trusted plugin admission unavailable on Windows"), {
      code: "TRUSTED_PLUGIN_HOST_UNSUPPORTED",
    });
  }
}

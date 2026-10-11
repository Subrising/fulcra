/**
 * Whether this launch may skip Electron's single-instance lock. Only an isolated test instance
 * (its own userData directory) may run beside the real app; a stray override in a shell must not
 * bring back a second Fulcra app on the same profile.
 */
export function resolveSingleInstanceOverride(
  env: NodeJS.ProcessEnv,
): "lock" | "disabled" | "ignored" {
  if (env.PASEO_DISABLE_SINGLE_INSTANCE_LOCK !== "1") return "lock";
  return env.PASEO_ELECTRON_USER_DATA_DIR?.trim() ? "disabled" : "ignored";
}

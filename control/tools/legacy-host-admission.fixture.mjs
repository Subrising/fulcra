// Legacy journal-policy oracle only. This fixture models the new host's typed
// pre-dispatch RPC boundary around explicit admission checks, never provider calls.
// Production and real-host parity do not import this module.
import * as legacy from "../src/control/admission-guard.mjs";
import { DaemonRpcError } from "../src/control/client-sdk.mjs";
export * from "../src/control/admission-guard.mjs";
export const refused = (message) =>
  new DaemonRpcError({
    code: "admission_refused",
    nativeDispatched: false,
    requestId: "legacy-fixture",
    error: message,
  });
const check =
  (fn) =>
  (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      throw refused(error.message);
    }
  };
export const admit = check(legacy.admit);
export const admitPermission = check(legacy.admitPermission);

import {
  nativeTurnOptions as legacyNativeTurnOptions,
  quotaFailure,
} from "../src/control/native-turn.mjs";
export { quotaFailure };
export function nativeTurnOptions(input) {
  const options = legacyNativeTurnOptions(input);
  if (typeof options[input.symbol] === "function")
    options[input.symbol] = check(options[input.symbol]);
  return options;
}

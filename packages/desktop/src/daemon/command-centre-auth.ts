import { createHash, randomBytes } from "node:crypto";
export interface CommandCentreKeychain {
  get(service: string): Promise<string | null>;
  set(service: string, password: string): Promise<void>;
}
const pending = new WeakMap<CommandCentreKeychain, Map<string, Promise<string>>>();
/** Never persist plaintext to daemon config or hand this credential to the controller. */
export async function commandCentreCredential(options: {
  enabled: boolean;
  home: string;
  existingPassword?: string;
  create?: boolean;
  keychain: CommandCentreKeychain;
}): Promise<string | null> {
  if (!options.enabled) return null;
  if (options.existingPassword) return options.existingPassword;
  const service =
    "ai.fulcra.command-centre." + createHash("sha256").update(options.home).digest("hex");
  let requests = pending.get(options.keychain);
  if (!requests) {
    requests = new Map();
    pending.set(options.keychain, requests);
  }
  const active = requests.get(service);
  if (active) return active;
  const request = (async () => {
    const existing = await options.keychain.get(service);
    if (existing) return existing;
    if (options.create === false)
      throw Error(
        "Command Centre credential missing. Restart the service to repair authentication.",
      );
    const password = randomBytes(32).toString("hex");
    await options.keychain.set(service, password);
    const readback = await options.keychain.get(service);
    if (readback === null) throw Error("Command Centre Keychain: not-found-after-write");
    if (readback !== password) throw Error("Command Centre Keychain: readback-mismatch");
    return password;
  })();
  requests.set(service, request);
  try {
    return await request;
  } finally {
    requests.delete(service);
  }
}

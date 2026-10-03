import { compare } from "bcryptjs";
import type { WSHelloMessage } from "@getpaseo/protocol/messages";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { matchesLocalCredential } from "./local-credential.js";
import type { SessionAdmission } from "./websocket-server.js";

export type AdmissionFailure = "password_required" | "incorrect_password";

type AdmissionResolution = { admission: SessionAdmission } | { rejection: AdmissionFailure };

export async function resolveSessionAdmission(input: {
  credential: WSHelloMessage["auth"];
  passwordHash: string | undefined;
  localCredential: string | null;
  transport: "direct" | "relay";
}): Promise<AdmissionResolution> {
  const { credential, passwordHash, localCredential, transport } = input;
<<<<<<< HEAD
  // Relay identity comes from the paired-device handshake, never a password or anonymous hello.
  if (transport === "relay") return { rejection: "password_required" };
=======
>>>>>>> refs/tags/v0.10.3
  if (!passwordHash) {
    return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
  }
  if (!credential) {
<<<<<<< HEAD
=======
    // COMPAT(relayPasswordOptional): added in v0.9.1, remove once release N mobile builds are live on App Store and Play.
    if (transport === "relay") {
      return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
    }
>>>>>>> refs/tags/v0.10.3
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
<<<<<<< HEAD
      return {
        admission: {
          principalId: "owner",
          permissions: OWNER_PERMISSIONS,
          authentication: { id: "owner", authentication: "daemon-password", deviceId: null },
        },
      };
=======
      return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
>>>>>>> refs/tags/v0.10.3
    }
    return { rejection: "incorrect_password" };
  }
  return (await compare(credential.password, passwordHash))
<<<<<<< HEAD
    ? {
        admission: {
          principalId: "owner",
          permissions: OWNER_PERMISSIONS,
          authentication: { id: "owner", authentication: "daemon-password", deviceId: null },
        },
      }
=======
    ? { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } }
>>>>>>> refs/tags/v0.10.3
    : { rejection: "incorrect_password" };
}

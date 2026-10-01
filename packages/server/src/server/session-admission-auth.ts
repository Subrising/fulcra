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
  // Relay identity comes from the paired-device handshake, never a password or anonymous hello.
  if (transport === "relay") return { rejection: "password_required" };
  if (!passwordHash) {
    return { admission: { principalId: "owner", permissions: OWNER_PERMISSIONS } };
  }
  if (!credential) {
    return { rejection: "password_required" };
  }
  if (credential.kind === "localCredential") {
    if (localCredential && matchesLocalCredential(localCredential, credential.token)) {
      return {
        admission: {
          principalId: "owner",
          permissions: OWNER_PERMISSIONS,
          authentication: { id: "owner", authentication: "daemon-password", deviceId: null },
        },
      };
    }
    return { rejection: "incorrect_password" };
  }
  return (await compare(credential.password, passwordHash))
    ? {
        admission: {
          principalId: "owner",
          permissions: OWNER_PERMISSIONS,
          authentication: { id: "owner", authentication: "daemon-password", deviceId: null },
        },
      }
    : { rejection: "incorrect_password" };
}

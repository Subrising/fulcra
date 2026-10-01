import { randomBytes } from "node:crypto";
import path from "node:path";
import { generateKeyPair, exportPublicKey, exportSecretKey } from "@getpaseo/relay/e2ee";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { withPairingLock, writeStore } from "./file-store.js";
// Caller must stop the daemon first. Write the new server id last; a partial
// failure cannot reactivate devices or outstanding offers for the old identity.
export function rotateOfflineRelayIdentity(home: string): void {
  if (process.env.PASEO_SERVER_ID)
    throw new Error("Remove the PASEO_SERVER_ID launch override before rotation");
  withPairingLock(home, () => {
    writeStore(home, "paired-devices.json", { v: 1, devices: [] });
    writeStore(home, "pairing-offers.json", []);
    const key = generateKeyPair();
    writeStore(home, "daemon-keypair.json", {
      v: 2,
      publicKeyB64: exportPublicKey(key.publicKey),
      secretKeyB64: exportSecretKey(key.secretKey),
    });
    writePrivateFileAtomicSync(
      path.join(home, "server-id"),
      `srv_${randomBytes(9).toString("base64url")}\n`,
    );
  });
}

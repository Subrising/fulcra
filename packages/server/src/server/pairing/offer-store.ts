import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readStore, withPairingLock, writeStore } from "./file-store.js";
const schema = z
  .array(
    z.object({ id: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number() }),
  )
  .max(4);
const filename = "pairing-offers.json";
const hash = (secret: string) => createHash("sha256").update(secret).digest();
export class OfferStore {
  constructor(private readonly home: string) {}
  mint(ttlSeconds = 600, now = Date.now()) {
    return withPairingLock(this.home, () => {
      const secret = randomBytes(32).toString("base64url");
      const id = randomBytes(16).toString("base64url");
      const expiresAt = now + Math.max(60, Math.min(3600, ttlSeconds)) * 1000;
      const offers = schema
        .parse(readStore(this.home, filename) ?? [])
        .filter((o) => o.expiresAt > now)
        .slice(-3);
      offers.push({ id, hash: hash(secret).toString("hex"), expiresAt });
      writeStore(this.home, filename, offers);
      return { id, secret, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  claim(id: string, secret: string, now = Date.now()): boolean {
    return withPairingLock(this.home, () => {
      const offers = schema.parse(readStore(this.home, filename) ?? []);
      const found = offers.find((o) => o.id === id);
      if (
        !found ||
        found.expiresAt <= now ||
        !timingSafeEqual(hash(secret), Buffer.from(found.hash, "hex"))
      )
        return false;
      writeStore(
        this.home,
        filename,
        offers.filter((o) => o.id !== id),
      );
      return true;
    });
  }
}

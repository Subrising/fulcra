import { describe, expect, it } from "vitest";
import {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
} from "./connection-offer.js";
const offer = {
  v: 3,
  serverId: "srv_fixture",
  daemonPublicKeyB64: Buffer.alloc(32, 1).toString("base64"),
  relay: { endpoint: "127.0.0.1:8787", useTls: false },
  pairing: { id: "A".repeat(22), secret: "B".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" },
};
describe("v3 pairing offer", () => {
  it("round-trips an out-of-band Fulcra link", () => {
    const encoded = Buffer.from(JSON.stringify(offer)).toString("base64url");
    expect(parseConnectionOfferFromUrl(`fulcra://pair#offer=${encoded}`)).toEqual(offer);
    expect(decodeOfferFragmentPayload(encoded)).toEqual(offer);
  });
  it("refuses v2 with an update instruction", () =>
    expect(() => ConnectionOfferSchema.parse({ ...offer, v: 2 })).toThrow("Update Fulcra"));
  it("refuses public relays without TLS", () =>
    expect(() =>
      ConnectionOfferSchema.parse({
        ...offer,
        relay: { endpoint: "relay.example.com:80", useTls: false },
      }),
    ).toThrow("secure connection"));
  it("rejects unexpected credential fields", () =>
    expect(() =>
      ConnectionOfferSchema.parse({ ...offer, pairing: { ...offer.pairing, extra: true } }),
    ).toThrow());
  it("returns null without an offer", () =>
    expect(parseConnectionOfferFromUrl("fulcra://pair")).toBeNull());
});

it("does not expose raw credentials in offer decode errors", () => {
  const secret = "PAIRING_SECRET_SENTINEL_DO_NOT_LOG";
  for (const raw of [`${secret}{`, JSON.stringify({ v: 3, [secret]: secret })]) {
    const url = "fulcra://pair#offer=" + Buffer.from(raw).toString("base64url");
    let error: unknown;
    try {
      parseConnectionOfferFromUrl(url);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
  }
});

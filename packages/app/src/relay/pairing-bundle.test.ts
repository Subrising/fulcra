import { describe, expect, it, vi } from "vitest";
import {
  buildPairingBundle,
  describeBundleResults,
  isPairingBundle,
  MAX_BUNDLE_OFFERS,
  pairEveryOffer,
  parsePairingBundle,
} from "./pairing-bundle";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const offerUrl = (serverId: string, hostLabel: string) =>
  `fulcra://pair#offer=${encode({
    v: 3,
    serverId,
    daemonPublicKeyB64: `${"A".repeat(43)}=`,
    relay: { endpoint: "relay.example.com:443", useTls: true },
    pairing: { id: "i".repeat(22), secret: "s".repeat(43), expiresAt: "2026-09-29T08:00:00.000Z" },
    hostLabel,
  })}`;

describe("pairing bundle", () => {
  const mini = offerUrl("srv_mini", "Mac-mini.local");
  const book = offerUrl("srv_book", "MacBook-Pro.local");

  it("carries each Mac's own one-time offer unchanged, and reads them back", () => {
    const bundle = buildPairingBundle([mini, book, mini]);
    expect(isPairingBundle(bundle)).toBe(true);
    expect(isPairingBundle(mini)).toBe(false);
    expect(bundle).toBe(
      `fulcra://pair#offers=${mini.split("#offer=")[1]},${book.split("#offer=")[1]}`,
    );
    expect(parsePairingBundle(bundle).map((o) => [o.serverId, o.hostLabel])).toEqual([
      ["srv_mini", "Mac-mini.local"],
      ["srv_book", "MacBook-Pro.local"],
    ]);
  });

  it("refuses anything malformed rather than pairing part of it", () => {
    expect(() => buildPairingBundle(["https://example.com"])).toThrow("Not a pairing link");
    expect(() => buildPairingBundle([])).toThrow("Nothing to pair with");
    const many = Array.from({ length: MAX_BUNDLE_OFFERS + 1 }, (_, i) =>
      offerUrl(`srv_${i}`, `Mac ${i}`),
    );
    expect(() => buildPairingBundle(many)).toThrow("Too many hosts");
    expect(() => parsePairingBundle(`${buildPairingBundle([mini])},not-an-offer`)).toThrow();
    expect(() => parsePairingBundle("fulcra://pair#offers=")).toThrow("no hosts");
  });

  it("pairs with each Mac in turn; one failing never stops the others", async () => {
    const offers = parsePairingBundle(buildPairingBundle([mini, book]));
    const pair = vi.fn(async (offer: { serverId: string }) => {
      if (offer.serverId === "srv_mini") throw new Error("the code expired");
    });
    const results = await pairEveryOffer(offers, pair);
    expect(pair).toHaveBeenCalledTimes(2);
    expect(describeBundleResults(results)).toBe(
      "Paired with MacBook-Pro.local. Could not pair with Mac-mini.local: the code expired",
    );
  });
});

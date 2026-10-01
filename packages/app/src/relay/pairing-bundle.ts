import { parseConnectionOffer, type ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import { decodeOfferFragmentPayload } from "@/utils/daemon-endpoints";

// Pair once, see every Mac. A bundle is several ordinary one-time offers in one link:
//   fulcra://pair#offers=<offer>,<offer>,...
// Each <offer> is exactly the encoded payload of a single-host link (fulcra://pair#offer=<offer>), minted by the
// host it admits to. Nothing in a bundle is a credential for another host: the new device claims each offer with
// its own key, and each host checks its own offer once. Base64url never contains a comma.
const BUNDLE = "#offers=";
const SINGLE = "#offer=";
export const MAX_BUNDLE_OFFERS = 8;

export function isPairingBundle(raw: string): boolean {
  return raw.includes(BUNDLE);
}

/** One link carrying every single-host offer link given, in order, without duplicates. */
export function buildPairingBundle(offerUrls: readonly string[]): string {
  if (offerUrls.some((url) => !url.includes(SINGLE))) throw new Error("Not a pairing link");
  const parts = [
    ...new Set(offerUrls.map((url) => url.slice(url.indexOf(SINGLE) + SINGLE.length).trim())),
  ].filter((part) => part.length > 0);
  if (!parts.length) throw new Error("Nothing to pair with");
  if (parts.length > MAX_BUNDLE_OFFERS) throw new Error("Too many hosts for one link");
  return `fulcra://pair${BUNDLE}${parts.join(",")}`;
}

/** The offers in a bundle link, one per host. Throws on anything malformed rather than pairing part of it. */
export function parsePairingBundle(raw: string): ConnectionOffer[] {
  const encoded = raw.slice(raw.indexOf(BUNDLE) + BUNDLE.length).trim();
  const parts = encoded.split(",").filter(Boolean);
  if (!parts.length) throw new Error("This link has no hosts to pair with");
  if (parts.length > MAX_BUNDLE_OFFERS) throw new Error("This link has too many hosts");
  const offers = parts.map((part) => parseConnectionOffer(decodeOfferFragmentPayload(part)));
  const seen = new Set<string>();
  return offers.filter((offer) => !seen.has(offer.serverId) && seen.add(offer.serverId));
}

export interface BundlePairResult {
  serverId: string;
  label: string;
  ok: boolean;
  error: string | null;
}

/** Pair with each host in turn; one host failing (offline, expired offer) never stops the others. */
export async function pairEveryOffer(
  offers: readonly ConnectionOffer[],
  pair: (offer: ConnectionOffer) => Promise<unknown>,
): Promise<BundlePairResult[]> {
  const results: BundlePairResult[] = [];
  for (const offer of offers) {
    const label = offer.hostLabel || "Unnamed host";
    try {
      await pair(offer);
      results.push({ serverId: offer.serverId, label, ok: true, error: null });
    } catch (error) {
      results.push({
        serverId: offer.serverId,
        label,
        ok: false,
        error: error instanceof Error ? error.message : "Could not pair",
      });
    }
  }
  return results;
}

/** "Paired with Mac-mini and MacBook-Pro. Could not pair with iMac: the code expired." */
export function describeBundleResults(results: readonly BundlePairResult[]): string {
  const names = (rs: readonly BundlePairResult[]) =>
    rs.length <= 2
      ? rs.map((r) => r.label).join(" and ")
      : `${rs
          .slice(0, -1)
          .map((r) => r.label)
          .join(", ")} and ${rs.at(-1)!.label}`;
  const ok = results.filter((r) => r.ok),
    failed = results.filter((r) => !r.ok);
  return [
    ok.length ? `Paired with ${names(ok)}.` : "",
    ...failed.map((r) => `Could not pair with ${r.label}: ${r.error}`),
  ]
    .filter(Boolean)
    .join(" ");
}

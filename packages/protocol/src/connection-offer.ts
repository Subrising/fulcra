import { z } from "zod";
import { relayUsesTls } from "./daemon-endpoints.js";

/**
 * Relay-only pairing offer.
 *
 * `serverId` is a stable daemon identifier scoped to `PASEO_HOME`, and is also
 * used as the relay session identifier.
 */
export const ConnectionOfferV3Schema = z
  .object({
    v: z.literal(3, { error: "Update Fulcra to pair" }),
    serverId: z.string().min(1).max(64),
    daemonPublicKeyB64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    relay: z.object({ endpoint: z.string().min(1), useTls: z.boolean() }),
    pairing: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
        secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: z.string().datetime(),
      })
      .strict(),
    hostLabel: z.string().max(64).optional(),
  })
  .strict()
  .superRefine((offer, ctx) => {
    try {
      relayUsesTls(offer.relay.endpoint, offer.relay.useTls);
    } catch {
      ctx.addIssue({ code: "custom", message: "This relay isn't using a secure connection" });
    }
  });
export const ConnectionOfferSchema = ConnectionOfferV3Schema;
export type ConnectionOffer = z.infer<typeof ConnectionOfferSchema>;

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  try {
    const json = decodeBase64UrlToUtf8(encoded);
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("Invalid pairing offer");
  }
}

const OFFER_FRAGMENT_PREFIX = "#offer=";

function extractOfferFragmentEncoded(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  return encoded.length > 0 ? encoded : null;
}

/**
 * Parse a pairing-offer URL of the form `fulcra://pair#offer=<base64url>`.
 *
 * Returns `null` if the input has no `#offer=` fragment. Throws if the fragment
 * exists but the payload is malformed or fails schema validation.
 */
export function parseConnectionOfferFromUrl(input: string): ConnectionOffer | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  const payload = decodeOfferFragmentPayload(encoded);
  return parseConnectionOffer(payload);
}

/** Use this at input boundaries; raw schema diagnostics can contain attacker-controlled keys. */
export function parseConnectionOffer(payload: unknown): ConnectionOffer {
  const parsed = ConnectionOfferSchema.safeParse(payload);
  if (parsed.success) return parsed.data;
  if (payload && typeof payload === "object" && "v" in payload && payload.v !== 3)
    throw new Error("Update Fulcra to pair");
  if (
    parsed.error.issues.some(
      (issue) => issue.message === "This relay isn't using a secure connection",
    )
  )
    throw new Error("This relay isn't using a secure connection");
  throw new Error("Invalid pairing offer");
}

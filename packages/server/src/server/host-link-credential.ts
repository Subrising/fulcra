import { timingSafeEqual } from "node:crypto";

/** These credentials select only host-link endpoints, including on password-free hosts. */
export function isHostLinkCredential(token: string | null): boolean {
  return token !== null && /^(hlink1|hchat1|hworker1)\./.test(token);
}

export function matchesHostLinkCredential(expected: string, provided: string | null): boolean {
  if (provided === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fulcra sign-in return links: `fulcra://oauth/<flowId>`, optionally followed by a query. The
// app and the desktop main process both use this one rule. It is matched on the raw string, before any URL
// normalisation, so repeated or trailing slashes, dot segments, credentials, ports, fragments and a differently
// cased scheme are all refused. The host still validates the flow, state and expiry itself.
const OAUTH_CALLBACK_LINK = /^fulcra:\/\/oauth\/([A-Za-z0-9_-]{8,128})(?:\?[^#\s]*)?$/;

export const OAUTH_CALLBACK_LINK_MAX_LENGTH = 4096;

export interface OAuthCallbackLink {
  url: string;
  flowId: string;
}

// The flow id when `input` is exactly a Fulcra sign-in return link, else null. `url` is `input` unchanged.
export function parseOAuthCallbackLink(input: unknown): OAuthCallbackLink | null {
  if (typeof input !== "string" || input.length > OAUTH_CALLBACK_LINK_MAX_LENGTH) return null;
  const match = OAUTH_CALLBACK_LINK.exec(input);
  if (!match?.[1]) return null;
  // The host parses the same string with URL; refuse anything URL would not read as this link.
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "fulcra:" || parsed.hash) return null;
  return { url: input, flowId: match[1] };
}

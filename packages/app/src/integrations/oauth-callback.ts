// Fulcra J4 (CONTRACTS §7.2 v1.4): the sign-in return link `fulcra://oauth/<flowId>?…`. The app hands the URL,
// unchanged, to the host that started the sign-in (`credentials.complete({ kind: "callback", url })`); the host
// checks the path, state and expiry itself and consumes the flow once. Nothing here reads or keeps the code.
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { parseOAuthCallbackLink } from "@getpaseo/protocol/oauth-callback-link";

// The flow id when `input` is exactly a Fulcra sign-in return link, else null. One rule with desktop.
export const parseOAuthCallback = parseOAuthCallbackLink;

type CallbackClient = Pick<DaemonClient, "completeCredentialSignIn" | "ownsSignInFlow">;
export type OAuthCallbackOutcome =
  | { status: "connected"; displayName: string }
  | { status: "pending" }
  | { status: "failed"; message: string };

const START_AGAIN = "Start it again from Settings › Integrations.";

// Sends the link to the one connected host whose client started this flow (R-E-11). The link carries the
// authorization code and state, so no other host ever receives it: with no owner, or an ambiguous one, nothing
// is sent.
export async function forwardOAuthCallback(
  input: unknown,
  clients: readonly CallbackClient[],
): Promise<OAuthCallbackOutcome> {
  const parsed = parseOAuthCallback(input);
  if (!parsed) return { status: "failed", message: "That link is not a Fulcra sign-in link." };
  const owners = [...new Set(clients)].filter((client) => client.ownsSignInFlow(parsed.flowId));
  if (owners.length !== 1) {
    return {
      status: "failed",
      message: `This sign-in wasn't started from this app, or it has expired. ${START_AGAIN}`,
    };
  }
  try {
    const result = await owners[0]!.completeCredentialSignIn({
      input: { kind: "callback", url: parsed.url },
    });
    return result.status === "connected"
      ? { status: "connected", displayName: result.account.displayName }
      : { status: "pending" };
  } catch {
    return { status: "failed", message: `The sign-in could not be finished. ${START_AGAIN}` };
  }
}

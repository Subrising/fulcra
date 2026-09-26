// sign-in return links `fulcra://oauth/<flowId>?…`. The main process only
// recognises them and forwards the exact string to the renderer, which hands it to the host that started the
// sign-in; nothing here reads the code or state. The shape rule is shared with the app.
import { parseOAuthCallbackLink } from "@getpaseo/protocol/oauth-callback-link";

export function isOAuthCallbackLink(input: unknown): input is string {
  return parseOAuthCallbackLink(input) !== null;
}

export function findOAuthCallbackInArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => isOAuthCallbackLink(arg)) ?? null;
}

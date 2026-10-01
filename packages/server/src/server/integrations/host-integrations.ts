import path from "node:path";
import type pino from "pino";
import { setGitHubAccountTokenResolver } from "../../services/github-service.js";
import type { PushDeliveryReport, PushPayload } from "../push/index.js";
import { PluginNotificationCenter } from "../plugins/plugin-notifications.js";
import type { PluginHostServices } from "../plugins/plugin-host-calls.js";
import { createFileAccountsStore } from "./accounts-store.js";
import { createPlatformCredentialBackend, type CredentialBackend } from "./credential-backend.js";
import { CredentialService } from "./credential-service.js";
import { createHostGithubSignIn, type HostGithubSignIn } from "./host-github-sign-in.js";
import { openOAuthLoopback } from "./oauth-loopback.js";

export interface HostIntegrations {
  services: PluginHostServices;
  dispose(): void;
}

// Builds the daemon's host plugin APIs: the shared credential store (on platforms with an OS
// credential store) and plugin notifications. It also points the GitHub forge layer at the same
// accounts, so PR panels and plugins share one sign-in.
export function createHostIntegrations(options: {
  paseoHome: string;
  serverId: string;
  logger: pino.Logger;
  oauthClientIds?: Readonly<Record<string, string>>;
  // Defaults to the platform's OS credential store; `null` means none.
  backend?: CredentialBackend | null;
  // Defaults to this Mac's `gh` login when there is a credential store; `null` means none.
  hostSignIn?: HostGithubSignIn | null;
  // Resolved at send time: the WebSocket server that owns device push tokens starts later.
  sendPush: (payload: PushPayload) => Promise<PushDeliveryReport>;
}): HostIntegrations {
  const backend =
    options.backend === undefined ? createPlatformCredentialBackend() : options.backend;
  // This Mac's own GitHub sign-in names "you" without an extra step. It is read on the first listing
  // after each start and then on a short in-memory cache, so a daemon that never lists runs no `gh`.
  const hostSignIn =
    backend && options.hostSignIn !== null
      ? (options.hostSignIn ??
        createHostGithubSignIn({
          log: (message, fields) =>
            options.logger.child({ module: "host-github-sign-in" }).info(fields, message),
        }))
      : undefined;
  const credentials = backend
    ? new CredentialService({
        accounts: createFileAccountsStore(
          path.join(options.paseoHome, "integrations", "accounts.json"),
        ),
        backend,
        clientIds: () => options.oauthClientIds ?? {},
        openLoopback: openOAuthLoopback,
        hostSignIn,
      })
    : undefined;
  setGitHubAccountTokenResolver(
    credentials ? (host) => credentials.githubTokenForHost(host) : null,
  );
  const notifications = new PluginNotificationCenter({
    push: { send: options.sendPush },
    serverId: options.serverId,
    logger: options.logger.child({ module: "plugin-notifications" }),
    filePath: path.join(options.paseoHome, "plugin-notifications.json"),
  });
  return {
    services: { credentials, notifications },
    dispose() {
      credentials?.dispose();
      notifications.dispose();
      setGitHubAccountTokenResolver(null);
    },
  };
}

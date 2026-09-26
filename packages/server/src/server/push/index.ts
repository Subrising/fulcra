import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushDeliveryReport {
  // Registered devices the push was addressed to, and how many the push service accepted.
  devices: number;
  accepted: number;
}

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
  // Throws when the push service could not be reached, so the caller can retry.
  sendReporting(payload: PushPayload): Promise<PushDeliveryReport>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
  deliverReporting?: (tokens: string[], payload: PushPayload) => Promise<number>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));
  const deliverReporting =
    options.deliverReporting ??
    ((tokens: string[], payload: PushPayload) => service.sendPushReporting(tokens, payload));

  return {
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await deliver(tokens, payload);
    },
    async sendReporting(payload) {
      const tokens = store.getActiveTokens();
      if (tokens.length === 0) return { devices: 0, accepted: 0 };
      return { devices: tokens.length, accepted: await deliverReporting(tokens, payload) };
    },
  };
}

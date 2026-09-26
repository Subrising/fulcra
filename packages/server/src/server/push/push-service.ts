import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  constructor(logger: pino.Logger, revokeToken: (token: string) => void) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    await Promise.all(
      this.batches(tokens, payload).map((batch) =>
        this.deliverBatch(batch).catch((error: unknown) => {
          this.logger.error({ err: error }, "Failed to send push notifications");
        }),
      ),
    );
  }

  // Like sendPush, but reports how many devices Expo accepted and throws when the push service
  // could not be reached or refused the request, so a caller can retry.
  async sendPushReporting(tokens: string[], payload: PushPayload): Promise<number> {
    const accepted = await Promise.all(
      this.batches(tokens, payload).map((batch) => this.deliverBatch(batch)),
    );
    return accepted.reduce((total, count) => total + count, 0);
  }

  private batches(tokens: string[], payload: PushPayload): ExpoPushMessage[][] {
    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }
    return batches;
  }

  // Returns the number of messages Expo accepted; throws on a network or API error.
  private async deliverBatch(messages: ExpoPushMessage[]): Promise<number> {
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      this.logger.error(
        { status: response.status, statusText: response.statusText },
        "Expo push API error",
      );
      throw new Error(`Expo push API error ${response.status}`);
    }

    const result = (await response.json()) as { data: ExpoPushTicket[] };
    this.handleTickets(messages, result.data);
    return result.data.filter((ticket) => ticket.status === "ok").length;
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.revokeToken(message.to);
        }
      }
    }
  }
}

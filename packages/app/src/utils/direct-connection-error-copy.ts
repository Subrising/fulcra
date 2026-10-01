import { redactCredential } from "@getpaseo/protocol/daemon-credential";
import { CONNECTION_OPEN_FAILED } from "@getpaseo/client/internal/daemon-client";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";

// What the direct-connection form says when a connection fails. The entered password never appears in it, in any
// form (F02), and the words are plain: no "daemon", "WebSocket" or "subprotocol" (F03).

export interface DirectConnectionLabels {
  hostRequired: string;
  invalidPort: string;
  invalidConnection: string;
  failedToConnect: (endpoint: string) => string;
  noAdditionalDetails: (detail: string) => string;
  timedOut: string;
  refused: string;
  hostNotFound: string;
  hostUnreachable: string;
  tlsError: string;
  unableToConnect: string;
  /** "Couldn't sign in to this Mac: {{reason}}. Check the password, or try again." */
  signInFailed: (reason: string) => string;
  reasonIncorrectPassword: string;
  reasonPasswordRequired: string;
  reasonCouldNotOpen: string;
}

/** Technical text that never helps and may have carried the credential. */
const TECHNICAL = /websocket|subprotocol|daemon|paseo|bearer|fulcra\.auth/i;

function normalizeTransportMessage(message: string | null | undefined): string | null {
  const trimmed = message?.trim();
  return trimmed ? trimmed : null;
}

function formatTechnicalTransportDetails(
  details: (string | null)[],
  labels: DirectConnectionLabels,
): string | null {
  const unique = Array.from(
    new Set(
      details
        .map((value) => normalizeTransportMessage(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (unique.length === 0) return null;
  const allGeneric = unique.every((value) => {
    const lower = value.toLowerCase();
    return lower === "transport error" || lower === "transport closed";
  });
  if (allGeneric) return labels.noAdditionalDetails(unique[0] ?? "");
  return unique.join(" — ");
}

function rawDetailOf(error: unknown, labels: DirectConnectionLabels): string | null {
  if (error instanceof DaemonConnectionTestError) {
    return (
      formatTechnicalTransportDetails([error.reason, error.lastError], labels) ??
      normalizeTransportMessage(error.message)
    );
  }
  if (error instanceof Error) return normalizeTransportMessage(error.message);
  return null;
}

function detailFor(raw: string | null, labels: DirectConnectionLabels): string {
  const lower = raw?.toLowerCase() ?? "";
  if (raw === "Incorrect password") return labels.signInFailed(labels.reasonIncorrectPassword);
  if (raw === "Password required") return labels.signInFailed(labels.reasonPasswordRequired);
  if (raw?.includes(CONNECTION_OPEN_FAILED) || lower.includes("subprotocol"))
    return labels.signInFailed(labels.reasonCouldNotOpen);
  if (lower.includes("timed out")) return labels.timedOut;
  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("err_connection_refused")
  )
    return labels.refused;
  if (lower.includes("enotfound") || lower.includes("not found")) return labels.hostNotFound;
  if (lower.includes("ehostunreach") || lower.includes("host is unreachable"))
    return labels.hostUnreachable;
  if (lower.includes("certificate") || lower.includes("tls") || lower.includes("ssl"))
    return labels.tlsError;
  return labels.unableToConnect;
}

export function buildConnectionFailureCopy(input: {
  endpoint: string;
  error: unknown;
  labels: DirectConnectionLabels;
  /** The password the person typed: removed from anything shown, in every form. */
  password?: string | null;
}): { title: string; detail: string; raw: string | null } {
  const { endpoint, error, labels, password } = input;
  const unsafe = rawDetailOf(error, labels);
  const detail = detailFor(unsafe, labels);
  const redacted = unsafe === null ? null : redactCredential(unsafe, password);
  // Technical text is never shown (it can name the credential and helps nobody); plain text is, once redacted.
  const raw = redacted !== null && !TECHNICAL.test(redacted) ? redacted : null;
  return { title: redactCredential(labels.failedToConnect(endpoint), password), detail, raw };
}

import { describe, expect, it } from "vitest";
import { daemonAuthProtocols, encodeDaemonPassword } from "@getpaseo/protocol/daemon-credential";
import { CONNECTION_OPEN_FAILED } from "@getpaseo/client/internal/daemon-client";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import {
  buildConnectionFailureCopy,
  type DirectConnectionLabels,
} from "./direct-connection-error-copy";

const labels: DirectConnectionLabels = {
  hostRequired: "Host is required",
  invalidPort: "Port must be between 1 and 65535",
  invalidConnection: "Invalid connection",
  failedToConnect: (endpoint) => `We failed to connect to ${endpoint}.`,
  noAdditionalDetails: (detail) => `${detail} (no additional details provided)`,
  timedOut: "The connection timed out. Check this Mac's address and your network.",
  refused: "Connection refused. Is the server running at this address?",
  hostNotFound: "Host not found.",
  hostUnreachable: "Host is unreachable.",
  tlsError: "Couldn't make a secure connection.",
  unableToConnect: "Couldn't reach this Mac. Check its address and your network, or try again.",
  signInFailed: (reason) =>
    `Couldn't sign in to this Mac: ${reason}. Check the password, or try again.`,
  reasonIncorrectPassword: "the password isn't right",
  reasonPasswordRequired: "this Mac needs its password",
  reasonCouldNotOpen: "the connection couldn't be opened",
};
// Synthetic only: every printable ASCII character and some non-ASCII.
const PASSWORD = `${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")}日本🔐`;

function shown(copy: { title: string; detail: string; raw: string | null }): string {
  return [copy.title, copy.detail, copy.raw ?? ""].join("\n");
}

describe("direct connection errors (F02, F03)", () => {
  it("never shows the password, in any form, even when the underlying error contains it", () => {
    const leaks = [
      new Error(
        `Failed to construct 'WebSocket': The subprotocol '${daemonAuthProtocols(PASSWORD)[1]}' is invalid.`,
      ),
      new Error(`The subprotocol 'paseo.bearer.${PASSWORD}' is invalid.`),
      new Error(`boom ${PASSWORD}`),
      new DaemonConnectionTestError("x", {
        reason: `reason ${PASSWORD}`,
        lastError: `last ${encodeDaemonPassword(PASSWORD)}`,
      }),
    ];
    for (const error of leaks) {
      const text = shown(
        buildConnectionFailureCopy({
          endpoint: "mac.local:6767",
          error,
          labels,
          password: PASSWORD,
        }),
      );
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(encodeDaemonPassword(PASSWORD));
      expect(text).not.toMatch(/daemon|websocket|subprotocol|paseo/i);
    }
  });

  it("says plainly that sign-in failed, with the reason and what to do", () => {
    const construction = buildConnectionFailureCopy({
      endpoint: "mac.local:6767",
      error: new Error(CONNECTION_OPEN_FAILED),
      labels,
      password: PASSWORD,
    });
    expect(construction.detail).toBe(
      "Couldn't sign in to this Mac: the connection couldn't be opened. Check the password, or try again.",
    );
    const wrong = buildConnectionFailureCopy({
      endpoint: "mac.local:6767",
      error: new DaemonConnectionTestError("x", { reason: "Incorrect password", lastError: null }),
      labels,
      password: PASSWORD,
    });
    expect(wrong.detail).toBe(
      "Couldn't sign in to this Mac: the password isn't right. Check the password, or try again.",
    );
  });
});

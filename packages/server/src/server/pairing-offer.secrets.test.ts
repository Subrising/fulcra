import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { Writable } from "node:stream";
vi.mock("./pairing-qr.js", () => ({
  renderPairingQr: async () => {
    throw Object.assign(new Error("QR render failed"), { pairingUrl: "QR_SECRET_SENTINEL" });
  },
}));
import { generateLocalPairingOffer } from "./pairing-offer.js";
it("QR failure logging never includes renderer error details", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-qr-log-"));
  const logs: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(data, _, done) {
        logs.push(String(data));
        done();
      },
    }),
  );
  try {
    await generateLocalPairingOffer({
      paseoHome: home,
      relayEnabled: true,
      relayEndpoint: "127.0.0.1:8787",
      logger,
    });
    expect(logs.join("")).toContain("Failed to render pairing QR");
    expect(logs.join("")).not.toContain("QR_SECRET_SENTINEL");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

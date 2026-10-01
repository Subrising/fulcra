import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pairingBodyState,
  PAIRING_OFFER_TIMEOUT_MS,
  relayAddressFieldValue,
  withTimeout,
} from "./pairing-body-state";

const base = { isFetching: false, hasAnswer: false, error: null };

describe("pairingBodyState (L42)", () => {
  it("never says loading while the host is connecting or idle, even though the disabled query is pending", () => {
    for (const connectionStatus of ["connecting", "idle", undefined] as const) {
      expect(pairingBodyState({ ...base, connectionStatus })).toBe("connecting");
      expect(pairingBodyState({ ...base, connectionStatus, isFetching: true })).toBe("connecting");
    }
  });

  it("keeps offline and error as the disconnected state", () => {
    expect(pairingBodyState({ ...base, connectionStatus: "offline" })).toBe("disconnected");
    expect(pairingBodyState({ ...base, connectionStatus: "error", isFetching: true })).toBe(
      "disconnected",
    );
  });

  it("says loading only while the online request is in flight", () => {
    expect(pairingBodyState({ ...base, connectionStatus: "online", isFetching: true })).toBe(
      "loading",
    );
    expect(pairingBodyState({ ...base, connectionStatus: "online" })).toBe("offer");
    expect(
      pairingBodyState({ ...base, connectionStatus: "online", isFetching: true, hasAnswer: true }),
    ).toBe("offer");
  });

  it("shows a failed or timed-out request as an error", () => {
    const error = new Error("timed out");
    expect(pairingBodyState({ ...base, connectionStatus: "online", error })).toBe("error");
  });
});

describe("withTimeout (L42)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with the plain message when the offer never arrives", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(
      new Promise<never>(() => {}),
      PAIRING_OFFER_TIMEOUT_MS,
      "Timed out",
    );
    const settled = expect(pending).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(PAIRING_OFFER_TIMEOUT_MS);
    await settled;
  });

  it("passes an answer or a failure through before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("offer"), 1000, "late")).resolves.toBe("offer");
    await expect(withTimeout(Promise.reject(new Error("refused")), 1000, "late")).rejects.toThrow(
      "refused",
    );
  });
});

describe("relayAddressFieldValue", () => {
  it("never puts the default relay's raw address in the field", () => {
    expect(relayAddressFieldValue("relay.paseo.sh:443")).toBe("");
    expect(relayAddressFieldValue(null)).toBe("");
    expect(relayAddressFieldValue(undefined)).toBe("");
    expect(relayAddressFieldValue("relay.example.com:443")).toBe("relay.example.com:443");
  });
});

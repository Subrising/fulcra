import { describe, expect, it } from "vitest";
<<<<<<< HEAD
import { serializeRelayConnectionUri } from "@/utils/daemon-endpoints";
import { PairingTargetTracker } from "./pair-link-credentials";

function relayLink(serverId: string): string {
  return serializeRelayConnectionUri({
    offer: {
      v: 3,
      serverId,
      daemonPublicKeyB64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      relay: { endpoint: "relay.example:443", useTls: true },
      pairing: {
        id: "A".repeat(22),
        secret: "B".repeat(43),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  });
}

describe("pairing target password", () => {
  it("clears the password and hides its input when switching hosts", () => {
    const first = relayLink("srv_a");
    const second = relayLink("srv_b");
=======
import { PairingTargetTracker } from "./pair-link-credentials";

describe("pairing target password", () => {
  it("clears the password and hides its input when switching hosts", () => {
    const first = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const second = "relay://relay.example:443/srv_b?key=BBBB&ssl=true";
>>>>>>> refs/tags/v0.10.3
    const target = new PairingTargetTracker(first);
    expect(target.changeUrl("relay://relay.example:443/")).toBe(false);
    expect(target.changeUrl(second)).toBe(true);
    expect(target.changeUrl(second)).toBe(false);
  });

  it("clears the direct form credential when its advanced URI changes to a relay target", () => {
    const target = new PairingTargetTracker("", true);
<<<<<<< HEAD
    expect(target.changeUrl(relayLink("srv_new"))).toBe(true);
  });

  it("keeps the password when a relay URI receives harmless whitespace", () => {
    const uri = relayLink("srv_a");
=======
    expect(target.changeUrl("relay://relay.example:443/srv_new?key=BBBB&ssl=true")).toBe(true);
  });

  it("keeps the password when a relay URI receives harmless whitespace", () => {
    const uri = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
>>>>>>> refs/tags/v0.10.3
    const target = new PairingTargetTracker(uri);
    expect(target.changeUrl(`${uri} `)).toBe(false);
  });

  it("recognizes a different host in an offer link after an incomplete edit", () => {
    const offer = Buffer.from(
      JSON.stringify({
<<<<<<< HEAD
        v: 3,
        serverId: "srv_b",
        daemonPublicKeyB64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        pairing: {
          id: "A".repeat(22),
          secret: "B".repeat(43),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        relay: { endpoint: "relay.example:443", useTls: true },
      }),
    ).toString("base64url");
    const target = new PairingTargetTracker(relayLink("srv_a"));
=======
        v: 2,
        serverId: "srv_b",
        daemonPublicKeyB64: "BBBB",
        relay: { endpoint: "relay.example:443" },
      }),
    ).toString("base64url");
    const target = new PairingTargetTracker("relay://relay.example:443/srv_a?key=AAAA");
>>>>>>> refs/tags/v0.10.3
    expect(target.changeUrl("https://app.paseo.sh/#offer=")).toBe(false);
    expect(target.changeUrl(`https://app.paseo.sh/#offer=${offer}`)).toBe(true);
  });
});

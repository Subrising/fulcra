import { describe, expect, it } from "vitest";
import {
  buildDaemonConnectionCommandError,
  normalizeDaemonHost,
  resolveDaemonPassword,
  resolveDaemonTarget,
} from "./client.js";

const MAGIC_DNS = "workstation.example-net.ts.net";

// What the OS resolver is actually asked for. The regression was not a DNS problem at all: a URL-form
// endpoint kept its scheme through normalizeDaemonHost and was wrapped again as
// `ws://wss://host:8443/ws`, so Node parsed "wss" as the hostname and getaddrinfo was asked to resolve
// "wss". The MagicDNS name never reached the resolver, which is why the OS could resolve it and the CLI
// could not.
function resolverWouldBeAskedFor(host: string): {
  hostname: string;
  port: string;
  protocol: string;
} {
  const url = new URL(resolveDaemonTarget(host).url);
  return { hostname: url.hostname, port: url.port, protocol: url.protocol };
}

describe("URL-form daemon endpoints", () => {
  it("asks the resolver for the host name, not the scheme", () => {
    for (const host of [`wss://${MAGIC_DNS}:8443`, `https://${MAGIC_DNS}:8443`]) {
      const asked = resolverWouldBeAskedFor(host);
      expect(asked.hostname).toBe(MAGIC_DNS);
      // The exact failure being pinned: before the fix this was "wss" / "https".
      expect(asked.hostname).not.toBe("wss");
      expect(asked.hostname).not.toBe("https");
      expect(asked.port).toBe("8443");
      expect(asked.protocol).toBe("wss:");
    }
  });

  it("keeps a TLS scheme as wss and a plaintext scheme as ws", () => {
    expect(resolveDaemonTarget(`wss://${MAGIC_DNS}:8443`).url).toBe(`wss://${MAGIC_DNS}:8443/ws`);
    expect(resolveDaemonTarget(`https://${MAGIC_DNS}:8443`).url).toBe(`wss://${MAGIC_DNS}:8443/ws`);
    expect(resolveDaemonTarget(`ws://${MAGIC_DNS}:6791`).url).toBe(`ws://${MAGIC_DNS}:6791/ws`);
    expect(resolveDaemonTarget(`http://${MAGIC_DNS}:6791`).url).toBe(`ws://${MAGIC_DNS}:6791/ws`);
  });

  it("supplies the scheme's default port when the URL omits one", () => {
    // parseHostPort requires an explicit port, so a portless URL would otherwise be rejected outright.
    // URL.toString() then drops the port again because it is the scheme default -- which is correct:
    // wss dials 443 and ws dials 80 without being told.
    expect(resolveDaemonTarget(`https://${MAGIC_DNS}`).url).toBe(`wss://${MAGIC_DNS}/ws`);
    expect(resolveDaemonTarget(`http://${MAGIC_DNS}`).url).toBe(`ws://${MAGIC_DNS}/ws`);
    expect(resolverWouldBeAskedFor(`https://${MAGIC_DNS}`).hostname).toBe(MAGIC_DNS);
  });

  it("brackets an IPv6 literal instead of splitting it on its colons", () => {
    expect(resolveDaemonTarget("wss://[fd7a::1]:8443").url).toBe("wss://[fd7a::1]:8443/ws");
    expect(resolverWouldBeAskedFor("wss://[fd7a::1]:8443").hostname).toBe("[fd7a::1]");
  });

  it("normalizes URL endpoints without losing the scheme", () => {
    expect(normalizeDaemonHost(`wss://${MAGIC_DNS}:8443`)).toBe(`wss://${MAGIC_DNS}:8443`);
    expect(normalizeDaemonHost(`https://${MAGIC_DNS}`)).toBe(`https://${MAGIC_DNS}:443`);
  });

  it("does not silently drop a password carried in the URL", () => {
    expect(resolveDaemonPassword(`wss://ignored:s3cret@${MAGIC_DNS}:8443`)).toBe("s3cret");
  });

  it("leaves the existing forms alone", () => {
    expect(resolveDaemonTarget(`${MAGIC_DNS}:8443`).url).toBe(`ws://${MAGIC_DNS}:8443/ws`);
    expect(resolveDaemonTarget("tcp://example.com:6767?ssl=true").url).toBe(
      "wss://example.com:6767/ws",
    );
    expect(resolveDaemonTarget("unix:///tmp/paseo.sock").type).toBe("ipc");
    expect(normalizeDaemonHost("6767")).toBe("127.0.0.1:6767");
    expect(normalizeDaemonHost("C:\\Users\\foo\\.paseo\\paseo.sock")).toBeNull();
  });
});

describe("scheme-less endpoint against a TLS listener", () => {
  // The other half of the reported evidence: `--host host:8443` resolves and connects, then the plain
  // ws handshake is rejected with HTTP 400. The status alone reads as a server fault.
  const rejected = (host: string) =>
    buildDaemonConnectionCommandError({
      target: { kind: "endpoint", host },
      error: new Error("Unexpected server response: 400"),
    }).message;

  it("names the scheme to use instead of leaving the reader with a bare 400", () => {
    const message = rejected(`${MAGIC_DNS}:8443`);
    expect(message).toContain("Unexpected server response: 400");
    expect(message).toContain(`wss://${MAGIC_DNS}:8443`);
    expect(message).toContain("dialled as plain ws://");
  });

  it("does not add the hint when a scheme was already given", () => {
    expect(rejected(`wss://${MAGIC_DNS}:8443`)).not.toContain("dialled as plain ws://");
  });
});

describe("what a stub resolver is asked", () => {
  it("receives the MagicDNS name, never the scheme", async () => {
    // client.ts performs no DNS itself -- resolution happens inside ws/net when the URL is dialled --
    // so the honest thing to pin is the hostname that gets handed over. This feeds the produced URL to
    // a stub lookup and records the name, with no network and no real resolver. Before the fix the
    // recorded name was "wss", which is exactly the reported getaddrinfo ENOTFOUND.
    const asked: string[] = [];
    const stubLookup = (
      hostname: string,
      _options: unknown,
      callback: (error: null, address: string, family: number) => void,
    ) => {
      asked.push(hostname);
      callback(null, "100.77.26.81", 4);
    };

    const { hostname } = new URL(resolveDaemonTarget(`wss://${MAGIC_DNS}:8443`).url);
    const address = await new Promise<string>((resolve) =>
      stubLookup(hostname, {}, (_error, resolved) => resolve(resolved)),
    );

    expect(asked).toEqual([MAGIC_DNS]);
    expect(address).toBe("100.77.26.81");
  });
});

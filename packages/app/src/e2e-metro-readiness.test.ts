import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import {
  metroNodeOptions,
  waitForMetro,
  warmMetro,
  warmupTimeoutMs,
} from "../e2e/support/global-setup";

class MetroPort {
  private readonly responses = new Map<string, { status: number; body: string }>();
  private readonly delays = new Map<string, number>();
  readonly requests: string[] = [];

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async listen(): Promise<MetroPort> {
    let endpoint!: MetroPort;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      endpoint.requests.push(pathname);
      const served = endpoint.responses.get(pathname) ?? { status: 500, body: "fallback" };
      const delay = endpoint.delays.get(pathname);
      const send = () => {
        response.writeHead(served.status, { "content-type": "text/plain" });
        response.end(served.body);
      };
      if (delay === undefined) {
        send();
        return;
      }
      const timer = setTimeout(send, delay);
      response.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to listen for Metro readiness test");
    }
    endpoint = new MetroPort(address.port, server);
    return endpoint;
  }

  serveMetro(): void {
    this.responses.set("/status", { status: 200, body: "packager-status:running" });
  }

  serveWarmableDocument(): void {
    this.responses.set("/", {
      status: 200,
      body: '<html><script src="/index.bundle?platform=web"></script></html>',
    });
    this.responses.set("/index.bundle", { status: 200, body: "compiled bundle" });
  }

  /** Metro answers the document immediately and streams the bundle only once it has compiled. */
  delayBundle(delayMs: number): void {
    this.delays.set("/index.bundle", delayMs);
  }

  failBundle(status: number): void {
    this.responses.set("/index.bundle", { status, body: "bundle failure" });
  }

  serveEmptyDocument(): void {
    this.responses.set("/", { status: 200, body: "<html></html>" });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

let endpoint: MetroPort | null = null;

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
});

test("Metro readiness rejects another HTTP listener on the selected port", async () => {
  endpoint = await MetroPort.listen();

  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).rejects.toThrow(
    "Expected Metro status",
  );

  endpoint.serveMetro();
  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).resolves.toBe(
    undefined,
  );
});

test("Metro warmup compiles the document's same-origin scripts before tests start", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();

  await warmMetro(endpoint.port);

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
});

// Expo declares NODE_ENV as required on ProcessEnv, so these fixtures carry it and stay plain
// objects: a cast would only hide the next missing field.
test("cold CI gets a longer startup allowance than a local run, and it stays overridable", () => {
  expect(warmupTimeoutMs({ NODE_ENV: "test" })).toBe(120_000);
  expect(warmupTimeoutMs({ NODE_ENV: "test", CI: "true" })).toBe(300_000);
  expect(
    warmupTimeoutMs({ NODE_ENV: "test", CI: "true", E2E_METRO_WARMUP_TIMEOUT_MS: "45000" }),
  ).toBe(45_000);
  expect(() => warmupTimeoutMs({ NODE_ENV: "test", E2E_METRO_WARMUP_TIMEOUT_MS: "soon" })).toThrow(
    "positive integer",
  );
});

// A shard died at Node's ~2GB default old-space seven minutes in, and every spec after that
// navigated to a dead bundler, so Metro gets explicit headroom.
test("Metro runs with raised heap headroom, keeping any inherited node options", () => {
  expect(metroNodeOptions({ NODE_ENV: "test" })).toBe("--max-old-space-size=4096");
  expect(metroNodeOptions({ NODE_ENV: "test", NODE_OPTIONS: "--enable-source-maps" })).toBe(
    "--enable-source-maps --max-old-space-size=4096",
  );
  expect(metroNodeOptions({ NODE_ENV: "test", E2E_METRO_MAX_OLD_SPACE_MB: "8192" })).toBe(
    "--max-old-space-size=8192",
  );
  expect(() => metroNodeOptions({ NODE_ENV: "test", E2E_METRO_MAX_OLD_SPACE_MB: "lots" })).toThrow(
    "positive integer",
  );
});

test("a bundle compiling inside the allowance warms, and past it reports progress", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();
  endpoint.delayBundle(150);
  const logs: string[] = [];
  const getRecentOutput = () =>
    "[metro] Web packages/app/index.ts ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 87.3% (4154/4449)";

  await warmMetro(endpoint.port, {
    timeoutMs: 2_000,
    heartbeatMs: 50,
    log: (line) => logs.push(line),
  });
  expect(logs.some((line) => line.includes("still compiling"))).toBe(true);

  await expect(
    warmMetro(endpoint.port, { timeoutMs: 50, getRecentOutput, log: () => {} }),
  ).rejects.toThrow(/bundle warmup for \/index\.bundle did not finish.*87\.3% \(4154\/4449\)/s);
});

test("warmup still fails on a bundle the server rejects", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();
  endpoint.failBundle(500);

  await expect(warmMetro(endpoint.port, { timeoutMs: 2_000 })).rejects.toThrow(
    "Metro bundle warmup failed for /index.bundle: HTTP 500",
  );
});

test("warmup still fails on a document with no bundle to compile", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveEmptyDocument();

  await expect(warmMetro(endpoint.port, { timeoutMs: 2_000 })).rejects.toThrow(
    "found no scripts to compile",
  );
});

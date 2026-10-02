import { createServer } from "node:net";
import { randomInt } from "node:crypto";

export const TEST_PORT_BLOCK_SIZE = 100;
export const FIRST_TEST_PORT = 10_000;
export const LAST_TEST_PORT = 29_999;

const configuredBase = process.env.PASEO_CLI_TEST_PORT_BASE;
const portBase =
  configuredBase === undefined
    ? FIRST_TEST_PORT + randomInt(200) * TEST_PORT_BLOCK_SIZE
    : Number(configuredBase);
if (
  !Number.isInteger(portBase) ||
  portBase < FIRST_TEST_PORT ||
  portBase + TEST_PORT_BLOCK_SIZE - 1 > LAST_TEST_PORT
) {
  throw new Error("Invalid CLI test port block");
}
const allocated = new Set<number>();

/**
 * Probe within this test's private block. The runner assigns disjoint blocks to
 * siblings; these ports also avoid standard outbound-client ephemeral ranges.
 * A listen(0) probe released before daemon startup can be stolen by either one.
 */
export async function getAvailablePort(): Promise<number> {
  const offset = randomInt(TEST_PORT_BLOCK_SIZE);
  for (let index = 0; index < TEST_PORT_BLOCK_SIZE; index++) {
    const port = portBase + ((offset + index) % TEST_PORT_BLOCK_SIZE);
    if (allocated.has(port)) continue;
    allocated.add(port);
    if (await probePort(port)) return port;
  }
  throw new Error("CLI test port block exhausted");
}

function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    server.unref();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => {
          reject(new Error("Failed to resolve an available TCP port"));
        });
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  });
}

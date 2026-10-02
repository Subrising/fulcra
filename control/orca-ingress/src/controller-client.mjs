import { localMachine } from "../../src/local-machine.mjs";
import net from "node:net";
import path from "node:path";
// The legacy controller's socket stays the default. After the cutover to the daemon-owned controller child, that controller
// serves socketLocation(<ORCA_HOME>) (src/control/socket-location.mjs); ORCA_INGRESS_CONTROLLER_SOCKET points the ingress at it.
// Unset or empty: the default, exactly as before. Set: an absolute canonical path, or the ingress refuses to start.
export const DEFAULT_CONTROLLER_SOCKET = localMachine("legacyControllerSocket");
export function controllerSocket(env = process.env) {
  const value = env.ORCA_INGRESS_CONTROLLER_SOCKET;
  if (value === undefined || value === "") return DEFAULT_CONTROLLER_SOCKET;
  if (!path.isAbsolute(value) || path.resolve(value) !== value)
    throw new Error("ORCA_INGRESS_CONTROLLER_SOCKET must be an absolute canonical path");
  return value;
}
const socket = controllerSocket();
export function request(envelope) {
  const data = JSON.stringify(envelope) + "\n";
  if (Buffer.byteLength(data) > 32768) throw new Error("Request too large");
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let bytes = "";
    client.setEncoding("utf8");
    client.setTimeout(30000, () =>
      client.destroy(
        new Error("Controller response timed out; inspect durable delivery before retrying"),
      ),
    );
    client.on("connect", () => client.write(data));
    client.on("error", reject);
    client.on("data", (chunk) => {
      bytes += chunk;
      if (Buffer.byteLength(bytes) > 524288)
        client.destroy(new Error("Controller response too large"));
    });
    client.on("end", () => {
      try {
        const value = JSON.parse(bytes);
        if (value.error)
          throw Object.assign(new Error(value.error), {
            code: value.code === "ORCA_INSTRUCTION_ALLOWANCE_EXHAUSTED" ? value.code : undefined,
          });
        resolve(value.result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

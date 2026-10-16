// Process stop control only. This channel never reads or transports an API key.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

export function createApiRuntimeChannel({ root, accountId, epoch = null, onStop }) {
  const dir = path.join(root, "accounts/api-runtimes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomUUID()}.json`);
  const stopToken = randomUUID();
  const socketDir = process.platform === "win32" ? null : fs.mkdtempSync("/tmp/fulcra-api-");
  const address = socketDir
    ? path.join(socketDir, "control.sock")
    : `\\\\.\\pipe\\fulcra-api-${randomUUID()}`;
  const replies = new Set();
  let closed = false;
  const server = net.createServer((socket) => {
    let input = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => replies.delete(socket));
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 64) {
        socket.end("denied\n");
        return;
      }
      if (!input.endsWith("\n")) return;
      const value = Buffer.from(input.trim()),
        expected = Buffer.from(stopToken);
      if (value.length !== expected.length || !timingSafeEqual(value, expected)) {
        socket.end("denied\n");
        return;
      }
      replies.add(socket);
      onStop();
    });
  });
  const release = () => {
    if (closed) return;
    closed = true;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* Missing cleanup evidence makes revoke fail. */
    }
    for (const socket of replies) socket.end("stopped\n");
    replies.clear();
    server.close();
    if (socketDir)
      try {
        fs.rmSync(socketDir, { recursive: true, force: true });
      } catch {
        /* Private temporary socket only. */
      }
  };
  try {
    server.on("error", onStop);
    server.listen(address);
    fs.writeFileSync(
      file,
      JSON.stringify({ accountId, epoch, ownerPid: process.pid, address, stopToken }),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    release();
    throw Error("The API process control channel is unavailable");
  }
  return { release };
}

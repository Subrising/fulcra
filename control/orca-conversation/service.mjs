import { WatchQueue, processOne } from "./queue.mjs";
import { installedConversation, LEGACY_HOME } from "./client.mjs";
import { setTimeout } from "node:timers/promises";

process.umask(0o077);
const queue = new WatchQueue(LEGACY_HOME + "/conversation-queue"); // the service's own state: it does not move with the controller home
const run = installedConversation({ waitMs: 1000 }); // one bounded controller event wait per lease
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
console.log(
  JSON.stringify({
    event: "watch-service-started",
    pid: process.pid,
    at: new Date().toISOString(),
  }),
);
try {
  while (!stopping) {
    queue.heartbeat();
    await Promise.all(Array.from({ length: 4 }, () => processOne(queue, run)));
    if (!stopping) await setTimeout(10000);
  }
} finally {
  queue.close();
}

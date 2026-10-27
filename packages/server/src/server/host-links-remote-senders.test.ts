import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";

import { HostLinks } from "./host-links.js";
import { writePrivateFileAtomicSync } from "./private-files.js";

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));

function outboxEntry(sender: string, state: "created" | "pending" | "refused") {
  return {
    hash: "h",
    grant: "g",
    sender,
    linkId: "link",
    sourceServerId: "source",
    profile: null,
    cwd: null,
    receipt: {
      serverId: "remote",
      messageId: randomUUID(),
      state,
      agentId: state === "created" ? "remote-worker" : null,
      token: null,
      endpoint: null,
    },
  };
}

test.runIf(process.platform !== "win32")(
  "remoteWorkerSenders lists the local sessions that started a worker on another host",
  () => {
    home = mkdtempSync(path.join(os.tmpdir(), "host-links-senders-"));
    const links = new HostLinks({ home, serverId: "source" } as never);
    expect(links.remoteWorkerSenders().size).toBe(0);
    writePrivateFileAtomicSync(
      path.join(home, "host-links-outbox.json"),
      JSON.stringify({
        a: outboxEntry("starter", "created"),
        b: outboxEntry("pending-sender", "pending"),
        c: outboxEntry("refused-sender", "refused"),
      }),
    );
    expect([...links.remoteWorkerSenders()]).toEqual(["starter"]);
  },
);

#!/usr/bin/env node
// Synthetic disposable state only. Never reads another home or contacts a provider.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { firstRun } from "../src/config.mjs";
import { ControlStore } from "../src/control/store.mjs";
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
export function generateScaleFixture(destination) {
  const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
  const root = path.join(parent, path.basename(destination));
  fs.mkdirSync(root, { mode: 0o700 }); // Exclusive: an existing home (including a symlink) is never seeded.
  const receipt = {
    schema: 1,
    kind: "SYNTHETIC REAL-SCALE STATE; NOT LIVE DATA",
    hosts: [],
    sessions: 280,
    deliveries: 5600,
    workspaces: 28,
    events: 5600,
    nativeTimelineRows: 5600,
  };
  for (let h = 0; h < 2; h++) {
    const hostRoot = path.join(root, `host-${h + 1}`),
      paseoHome = path.join(hostRoot, "paseo"),
      controlHome = path.join(paseoHome, "command-centre");
    for (const dir of [
      hostRoot,
      paseoHome,
      path.join(paseoHome, "agents"),
      path.join(paseoHome, "native-timeline-journal"),
      path.join(hostRoot, "workspaces"),
    ])
      fs.mkdirSync(dir, { mode: 0o700 });
    const config = firstRun({ ORCA_HOME: controlHome });
    const companyId = config.authority.companyId,
      programme = config.authority.programmeId;
    const issue = (id, projectId = null) => ({
      id,
      companyId,
      parentId: id === programme ? null : programme,
      assigneeUserId: "local-board",
      assigneeAgentId: null,
      status: "in_progress",
      projectId,
      title: "Synthetic RC task",
    });
    const projects = Array.from({ length: 14 }, (_, i) => ({
      id: randomUUID(),
      companyId,
      name: `RC Host ${h + 1} Project ${i + 1}`,
      description: "Synthetic release-candidate workspace",
      status: "in_progress",
    }));
    const issues = [issue(programme)],
      store = new ControlStore(path.join(controlHome, "journal.sqlite"));
    try {
      store.db
        .exec(`CREATE TABLE event_inbox(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,worker TEXT NOT NULL,supervisor TEXT NOT NULL,epoch TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,consumed TEXT,at TEXT NOT NULL);
    CREATE TABLE role_bindings(role TEXT NOT NULL,seat TEXT NOT NULL,projectId TEXT,task TEXT,session TEXT,sessionGeneration INTEGER,revision INTEGER NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL,membershipAt TEXT,at TEXT NOT NULL,PRIMARY KEY(role,seat));`);
      const oldBoot = randomUUID();
      for (let i = 0; i < 140; i++) {
        const id = randomUUID(),
          task = randomUUID(),
          project = projects[i % 14],
          cwd = path.join(hostRoot, "workspaces", project.id);
        fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        issues.push(issue(task, project.id));
        const at = new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString();
        write(path.join(paseoHome, "agents", id + ".json"), {
          id,
          provider: "claude",
          cwd,
          createdAt: at,
          updatedAt: at,
          title: `RC Host ${h + 1} Session ${i + 1}`,
          lastStatus: "idle",
          labels: { synthetic: "release-candidate" },
        });
        const history = Array.from({ length: 20 }, (_, j) => ({
          seq: j + 1,
          timestamp: new Date(Date.parse(at) + j * 60000).toISOString(),
          turnId: `synthetic-turn-${Math.floor(j / 2)}`,
          item:
            j % 2 === 0
              ? {
                  type: "user_message",
                  text: `Synthetic fixture instruction ${j / 2 + 1}; no provider is contacted.`,
                  clientMessageId: `synthetic-${id}-${j}`,
                }
              : {
                  type: "assistant_message",
                  text: `Synthetic settled answer ${Math.ceil(j / 2)}.`,
                  messageId: `synthetic-answer-${id}-${j}`,
                },
        }));
        fs.writeFileSync(
          path.join(
            paseoHome,
            "native-timeline-journal",
            createHash("sha256").update(id).digest("hex") + ".jsonl",
          ),
          JSON.stringify({ version: 1, agentId: id, epoch: randomUUID() }) +
            "\n" +
            JSON.stringify({ op: "append", rows: history }) +
            "\n",
          { mode: 0o600, flag: "wx" },
        );
        store.created(id, task, cwd);
        for (let j = 0; j < 20; j++) {
          const delivery = randomUUID();
          store.admit(delivery, id, "send", {
            messageId: delivery,
            taskId: task,
            text: `Synthetic settled history ${j + 1}`,
          });
          store.finish(delivery, "delivered", { synthetic: true, at });
          store.db
            .prepare("INSERT INTO event_inbox VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(
              randomUUID(),
              randomUUID(),
              id,
              id,
              oldBoot,
              "idle",
              JSON.stringify({ synthetic: true, sequence: j }),
              "consumed",
              at,
              at,
            );
        }
        // No usable capability is issued. Old-boot records exercise native observation and
        // usage-limit startup; missing human-chain evidence must decline automatic regrant.
        store.db
          .prepare(
            "UPDATE sessions SET mode='delegated',token=?,boot=?,grantedAt=1,authority=? WHERE id=?",
          )
          .run(
            createHash("sha256").update("unavailable-synthetic-capability").digest("hex"),
            oldBoot,
            JSON.stringify([
              [task, companyId, programme, "local-board", null, "in_progress"],
              [programme, companyId, null, "local-board", null, "in_progress"],
            ]),
            id,
          );
        if (i < 14)
          store.db
            .prepare("INSERT INTO role_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              "project-orchestrator",
              project.id,
              project.id,
              task,
              id,
              1,
              1,
              "assigned",
              "Synthetic stale seat; no restart evidence",
              at,
              at,
            );
      }
    } finally {
      store.close();
    }
    fs.writeFileSync(
      config.tasks,
      JSON.stringify({ version: 1, issues, projects }, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(controlHome, "seat-sweep.mode"), "on\n", {
      mode: 0o600,
      flag: "wx",
    });
    receipt.hosts.push({
      name: `RC synthetic host ${h + 1}`,
      paseoHome,
      controlHome,
      sessions: 140,
      workspaces: 14,
      staleSeats: 14,
      settledDeliveries: 2800,
      consumedEvents: 2800,
    });
  }
  write(path.join(root, "fixture.json"), receipt);
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw Error("Usage: real-scale-fixture.mjs <new-private-directory>");
  console.log(JSON.stringify(generateScaleFixture(process.argv[2]), null, 2));
}

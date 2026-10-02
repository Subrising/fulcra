import { portable, localIssues } from "./portable";
import { installationPath } from "./installation";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { ContractOutput } from "../shared/rpc-contract";
import { snapshotRpc } from "../shared/organization";
const ISSUE = portable.programme;
const COMPANY = portable.company;
const artifacts: Record<string, string[]> = portable.artifacts;
type Snapshot = ContractOutput<typeof snapshotRpc>;
// Fixed loopback endpoint, no redirects, credentials, caller-supplied URL or cached authority.
export function readBoard(request = http.get, issueId = ISSUE): Promise<Snapshot["board"]> {
  if (portable.authority.issueApi === null) {
    try {
      const row = localIssues().find((r) => r.id === issueId && r.companyId === COMPANY);
      if (!row || typeof row.title !== "string" || typeof row.status !== "string")
        throw Error("Unknown task");
      return Promise.resolve({
        available: true,
        identifier: String(row.identifier ?? issueId).slice(0, 64),
        title: row.title.slice(0, 512),
        status: row.status.slice(0, 64),
        owner: row.assigneeUserId ?? null,
        error: null,
      });
    } catch {
      return Promise.resolve({
        available: false,
        identifier: issueId,
        title: null,
        status: null,
        owner: null,
        error: "Local task unavailable",
      });
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Snapshot["board"]) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      }
    };
    const fail = () =>
      finish({
        available: false,
        identifier: issueId === ISSUE ? "AIN-73" : issueId,
        title: null,
        status: null,
        owner: null,
        error: "Task authority unavailable",
      });
    const req = request(`${portable.authority.issueApi}/api/issues/${issueId}`, (res) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      if (res.statusCode !== 200) {
        res.destroy();
        fail();
        return;
      }
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 131072) {
          res.destroy();
          fail();
        } else chunks.push(chunk);
      });
      res.on("error", fail);
      res.on("end", () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            d.id !== issueId ||
            d.companyId !== COMPANY ||
            typeof d.identifier !== "string" ||
            (issueId === ISSUE && d.identifier !== "AIN-73") ||
            typeof d.title !== "string" ||
            typeof d.status !== "string"
          )
            throw new Error("Wrong issue");
          const owner = d.assigneeUserId ?? d.assigneeAgentId;
          finish({
            available: true,
            identifier: d.identifier.slice(0, 64),
            title: d.title.slice(0, 512),
            status: d.status.slice(0, 64),
            owner: typeof owner === "string" ? owner.slice(0, 128) : null,
            error: null,
          });
        } catch {
          fail();
        }
      });
    });
    const deadline = setTimeout(() => {
      req.destroy();
      fail();
    }, 4000);
    req.on("error", fail);
  });
}
// No model or RPC input reaches this reader. It publishes hashes only, never file contents.
export function inspectArtifact(relative: string, configured?: string) {
  const name = path.basename(relative);
  let fd: number | undefined;
  try {
    const root = configured ?? installationPath("tasks");
    if (!Object.values(artifacts).flat().includes(relative)) throw new Error("Not published");
    const file = path.join(root, relative),
      parent = path.dirname(file);
    if (fs.realpathSync(root) !== root || fs.realpathSync(parent) !== parent)
      throw new Error("Symlink parent");
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 65536) throw new Error("Invalid artifact");
    const buffer = Buffer.alloc(65537);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      bytes !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      named.isSymbolicLink() ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw new Error("Changed during read");
    return {
      name,
      sha256: createHash("sha256").update(buffer.subarray(0, bytes)).digest("hex"),
      state: "Current file hash; acceptance separate",
    };
  } catch {
    return { name, sha256: null, state: "Unavailable or changed during read" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function project(agent: PaseoAgent): Snapshot["sessions"][number] {
  return {
    id: agent.id,
    title: (agent.title ?? "Untitled session").slice(0, 256),
    provider: agent.provider,
    model: agent.model,
    nativeId: agent.persistence?.sessionId ?? null,
    status: agent.status,
    updatedAt: agent.updatedAt,
    pending: agent.pendingPermissions.length,
    error: agent.lastError?.slice(0, 512) ?? null,
    artifacts: (artifacts[agent.id] ?? []).map((relative) => inspectArtifact(relative)),
  };
}
export async function organizationSnapshot(
  paseo: PaseoApi,
  boardReader = readBoard,
  membership?: ReadonlySet<string>,
): Promise<Snapshot> {
  const boardPromise = boardReader();
  const included = (id: string, owner?: string) =>
    membership ? membership.has(id) : /^orca(?:-|$)/.test(owner ?? "");
  const until = Date.now() + 8000;
  const bounded = <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = Math.min(3000, until - Date.now());
    if (remaining <= 0) return Promise.reject(new Error("Observation deadline"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Snapshot unavailable")), remaining);
      operation().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };
  const sessions: Snapshot["sessions"] = [];
  let sessionsAvailable = true,
    coverage = "Complete within this host's first 100 listed sessions";
  try {
    const listed = await bounded(() =>
      paseo.agents.list({ page: { limit: 100 }, sort: [{ key: "updated_at", direction: "desc" }] }),
    );
    const owned = listed.entries.filter((e) => included(e.agent.id, e.agent.labels.owner));
    if (listed.pageInfo.hasMore || owned.length > 32)
      coverage = "Partial: first 100 sessions, at most 32 Fulcra snapshots";
    // Sequential refresh bounds fan-out, with an eight-second total observation budget.
    for (const item of owned.slice(0, 32)) {
      try {
        const a = (await bounded(() => paseo.agents.ref(item.agent.id).refresh()))?.agent;
        if (a && a.id === item.agent.id && included(a.id, a.labels.owner))
          sessions.push(project(a));
        else coverage = "Partial: a listed session disappeared or changed ownership";
      } catch {
        coverage = "Partial: one or more session snapshots unavailable";
      }
    }
  } catch {
    sessionsAvailable = false;
    coverage = "Session service unavailable";
  }
  return {
    observedAt: new Date().toISOString(),
    host: portable.localHost.name,
    board: await boardPromise,
    sessionsAvailable,
    coverage,
    sessions,
    remote:
      "MacBook is not observed in this view. Select its Fulcra host to inspect it; no cross-host completion is inferred.",
  };
}

// One in-flight observation and a 30-second host-wide cache, shared by all viewers.
// Original observation time is retained; cache reuse never makes old facts look fresh.
export function createSnapshotReader(read: () => Promise<Snapshot>, now = Date.now) {
  let cached: Snapshot | undefined,
    expires = 0,
    flight: Promise<Snapshot> | undefined;
  return () => {
    if (flight) return flight;
    if (cached && now() < expires) return Promise.resolve(cached);
    flight = read()
      .then((value) => {
        cached = value;
        expires = now() + 30000;
        return value;
      })
      .finally(() => {
        flight = undefined;
      });
    return flight;
  };
}

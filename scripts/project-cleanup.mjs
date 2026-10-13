#!/usr/bin/env node
import { readFile, readdir, rename, writeFile, stat, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN = /^(DONE|MOVED)\b/i;
const OWNER_ROLE = /^(lead|owner|prime|orchestration|project-lead|main-assistant)$/i;
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

export function selectProjectCleanup({ projects, workspaces, agents, ledgerRows }) {
  const workspaceProjects = new Map(workspaces.map((row) => [row.workspaceId, row.projectId]));
  return projects.filter((project) => {
    if (project.archivedAt) return false;
    const parts = project.rootPath.split(path.sep);
    if (
      !UUID.test(project.displayName) &&
      !parts.some(
        (part, index) => UUID.test(part) && ["tasks", "worktrees"].includes(parts[index - 1]),
      ) &&
      !parts.includes("worktrees")
    )
      return false;
    const related = agents.filter(
      (agent) =>
        workspaceProjects.get(agent.workspaceId) === project.projectId ||
        inside(agent.cwd ?? "", project.rootPath),
    );
    if (related.some((agent) => !agent.archivedAt && agent.lastStatus !== "closed")) return false;
    if (
      related.some((agent) =>
        [agent.labels?.["fulcra.role"], agent.labels?.["fulcra.seat"], agent.labels?.role].some(
          (role) => OWNER_ROLE.test(role ?? ""),
        ),
      )
    )
      return false;
    const owners = new Set(
      [
        project.projectId,
        project.displayName,
        ...related.flatMap((agent) =>
          [agent.id, agent.id?.slice(0, 8), agent.title].filter(Boolean),
        ),
      ].map((value) => value.toLowerCase()),
    );
    const projectLabels = new Set(
      [
        project.displayName,
        ...related.flatMap((agent) =>
          [agent.labels?.project, agent.labels?.["fulcra.project"]].filter(Boolean),
        ),
      ].map((value) => value.toLowerCase()),
    );
    if (
      ledgerRows.some(
        (row) =>
          projectLabels.has((row.project ?? "").toLowerCase()) ||
          [...owners].some((owner) => row.owner.toLowerCase().includes(owner)),
      )
    )
      return false;
    return true;
  });
}

async function readAgents(dir) {
  const output = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) output.push(await readJson(file));
    }
  }
  await visit(dir);
  return output;
}

async function readLedgerRows(dir) {
  const rows = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "OPEN-ITEMS.md");
    const text = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .slice(1)
        .split("|")
        .map((cell) => cell.trim());
      if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(cells[0] ?? "") && !OPEN.test(cells[4] ?? ""))
        rows.push({ project: entry.name, owner: cells[3] ?? "" });
    }
  }
  return rows;
}

export async function inspectProjectCleanup(home, ledgerDir) {
  const [projects, workspaces, agents, ledgerRows] = await Promise.all([
    readJson(path.join(home, "projects", "projects.json")),
    readJson(path.join(home, "projects", "workspaces.json")),
    readAgents(path.join(home, "agents")),
    readLedgerRows(ledgerDir),
  ]);
  return {
    projects,
    workspaces,
    candidates: selectProjectCleanup({ projects, workspaces, agents, ledgerRows }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (args.includes("--dry-run") && apply) throw Error("Select one mode.");
  const value = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at < 0 ? fallback : args[at + 1];
  };
  const home = value("--home", process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"));
  const ledgerDir = value(
    "--ledger-dir",
    process.env.FULCRA_LEDGER_DIR || path.join(os.homedir(), "shared-vault", "projects"),
  );
  if (!home || !ledgerDir) throw Error("Home and ledger directory are required.");
  const first = await inspectProjectCleanup(home, ledgerDir);
  console.log(`${first.candidates.length} cleanup candidates`);
  for (const project of first.candidates)
    console.log(`${project.projectId}\t${project.displayName}\t${project.rootPath}`);
  if (!apply) return;
  const pidFile = path.join(home, "paseo.pid");
  const pid = await readJson(pidFile).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    pid?.pid &&
    (() => {
      try {
        process.kill(pid.pid, 0);
        return true;
      } catch (error) {
        return error.code === "EPERM";
      }
    })()
  )
    throw Error("Stop this daemon before --apply. The project registry is cached in memory.");
  const second = await inspectProjectCleanup(home, ledgerDir);
  const ids = first.candidates.map((project) => project.projectId).sort();
  if (
    JSON.stringify(ids) !==
    JSON.stringify(second.candidates.map((project) => project.projectId).sort())
  )
    throw Error("Candidate list changed. Run --dry-run again.");
  if (!ids.length) return;
  const file = path.join(home, "projects", "projects.json");
  const workspaceFile = path.join(home, "projects", "workspaces.json");
  const [before, workspaceBefore] = await Promise.all([stat(file), stat(workspaceFile)]);
  const timestamp = new Date().toISOString();
  const updated = second.projects.map((project) =>
    ids.includes(project.projectId)
      ? { ...project, archivedAt: timestamp, updatedAt: timestamp }
      : project,
  );
  const workspaceUpdated = second.workspaces;
  for (const workspace of workspaceUpdated) {
    if (ids.includes(workspace.projectId) && !workspace.archivedAt) {
      workspace.archivedAt = timestamp;
      workspace.updatedAt = timestamp;
    }
  }
  const projectTemp = `${file}.cleanup-${process.pid}.tmp`;
  const workspaceTemp = `${workspaceFile}.cleanup-${process.pid}.tmp`;
  const projectBackup = `${file}.cleanup-${timestamp}.bak`;
  const workspaceBackup = `${workspaceFile}.cleanup-${timestamp}.bak`;
  await Promise.all([
    writeFile(projectTemp, JSON.stringify(updated, null, 2) + "\n", { mode: before.mode }),
    writeFile(workspaceTemp, JSON.stringify(workspaceUpdated, null, 2) + "\n", {
      mode: workspaceBefore.mode,
    }),
  ]);
  await Promise.all([copyFile(file, projectBackup), copyFile(workspaceFile, workspaceBackup)]);
  if (
    (await stat(file)).mtimeMs !== before.mtimeMs ||
    (await stat(workspaceFile)).mtimeMs !== workspaceBefore.mtimeMs
  )
    throw Error("Registry changed. Run --dry-run again.");
  await rename(workspaceTemp, workspaceFile);
  try {
    await rename(projectTemp, file);
  } catch (error) {
    await copyFile(workspaceBackup, workspaceFile);
    throw error;
  }
  console.log(`Archived ${ids.length} projects.`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

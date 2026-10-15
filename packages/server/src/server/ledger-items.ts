import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Fulcra 0.2.17 (FU-101): the open items of the project ledgers (`ledger` command), read-only. A ledger is
// <dir>/<project>/OPEN-ITEMS.md, a table with the columns id | item | kind | owner | status | evidence | source.
// Only IDs, owners, statuses, and kinds are read. Item text is never sent.

export interface LedgerRow {
  project: string;
  id: string;
  owner: string;
  status: string;
  kind?: string;
}

/** Where the ledgers are: FULCRA_LEDGER_DIR, else ~/shared-vault/projects. */
export function defaultLedgerDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FULCRA_LEDGER_DIR?.trim() || path.join(homedir(), "shared-vault", "projects");
}

const MAX_FILE_BYTES = 512 * 1024;

/** The rows of one ledger file that are not DONE or MOVED. */
export function parseOpenRows(project: string, text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .slice(1)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 7) continue;
    const [id, , kind, owner, status] = cells;
    if (!id || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id)) continue;
    if (/^(DONE|MOVED)\b/.test(status ?? "")) continue;
    rows.push({ project, id, owner: owner ?? "", status: status ?? "", kind: kind ?? "" });
  }
  return rows;
}

/**
 * Every open row of every project ledger in `dir`. A missing or unreadable ledger gives no rows. The reads are
 * async: the ledger directory can sit on a slow disk, and the daemon main thread must not wait for it (FU-77).
 */
export async function readOpenLedgerRows(dir: string, strict = false): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let projects: string[] = [];
  try {
    projects = await readdir(dir);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Cannot list project ledgers", { cause: error });
    return rows;
  }
  for (const project of projects) {
    try {
      const file = path.join(dir, project, "OPEN-ITEMS.md");
      if ((await stat(file)).size > MAX_FILE_BYTES) {
        if (strict)
          throw Object.assign(new Error("Ledger exceeds its size limit"), {
            code: "LEDGER_SIZE_LIMIT",
          });
        continue;
      }
      rows.push(...parseOpenRows(project, await readFile(file, "utf8")));
    } catch (error) {
      if (
        strict &&
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      ) {
        const reason =
          (error as NodeJS.ErrnoException).code === "LEDGER_SIZE_LIMIT"
            ? "size limit exceeded"
            : "read failed";
        throw new Error(`Cannot read ledger for project "${project}": ${reason}`, { cause: error });
      }
      /* no ledger here */
    }
  }
  return rows;
}

/**
 * Match the lead title, full ID, short ID in brackets, or owner-selected project label.
 */
export function rowsOwnedBy(
  rows: readonly LedgerRow[],
  chat: { id: string; title: string; labels?: Record<string, string> | null },
): LedgerRow[] {
  const short = `(${chat.id.slice(0, 8)})`.toLowerCase();
  const title = chat.title.trim().toLowerCase();
  return rows.filter((row) => {
    const owner = row.owner.toLowerCase();
    return (
      owner === chat.id.toLowerCase() ||
      owner.includes(`(${chat.id.toLowerCase()})`) ||
      owner.includes(short) ||
      (title.length >= 4 && owner === title) ||
      [chat.labels?.["fulcra.project"], chat.labels?.project].some(
        (project) => !!project?.trim() && owner === project.trim().toLowerCase(),
      )
    );
  });
}

interface NudgeRowSelection {
  rows: readonly LedgerRow[];
  chat: { id: string; title: string; labels?: Record<string, string> | null };
  skipOwners?: readonly string[];
}

export function rowsEligibleForNudge({
  rows,
  chat,
  skipOwners = [],
}: NudgeRowSelection): LedgerRow[] {
  return rowsOwnedBy(rows, chat).filter((row) => {
    const status = row.status.trim();
    const kind = row.kind?.trim() ?? "";
    return (
      !isNudgeOwnerSkipped(row.owner, skipOwners) &&
      !/^(DONE|MOVED|BLOCKED|DECIDE|STANDING)\b/i.test(status) &&
      !/^(RULE|DECIDE|STANDING)\b/i.test(kind)
    );
  });
}

export function isNudgeOwnerSkipped(owner: string, skipOwners: readonly string[]): boolean {
  const normalizedOwner = owner.trim().toLowerCase();
  return skipOwners.some((entry) => entry.trim().toLowerCase() === normalizedOwner);
}

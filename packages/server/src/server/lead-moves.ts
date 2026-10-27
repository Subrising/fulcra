import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * FU-444: a lead that moved to another seat or another computer. `<paseoHome>/lead-moves.json` names the old lead and
 * the new one. A notice for the old lead (finish, permission, limit, nudge) then goes to the new lead: straight to it
 * when it is on this computer, else through the relay command for its computer (pcsend on a Mac, notify on the PC).
 * The worker's own labels stay as they are, so a parent label that only native adoption can change does not matter.
 * scripts/lead-move.mjs writes the file; the daemon reads it at each notice, so no restart is needed.
 */
export const LEAD_MOVES_FILE = "lead-moves.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LeadMoveSchema = z.object({
  from: z.string().regex(UUID),
  to: z.string().regex(UUID),
  /** The new lead's server id. Unset or this computer's id: delivered here. */
  server: z.string().min(1).max(64).optional(),
  /** argv for another computer: `{id}` is the new lead id, `{file}` a file with the notice text. */
  relay: z.array(z.string().min(1).max(1024)).min(1).max(16).optional(),
});
const LeadMovesSchema = z.object({
  version: z.literal(1),
  moves: z.array(LeadMoveSchema).max(256),
});
export type LeadMove = z.infer<typeof LeadMoveSchema>;

export type LeadMoveTarget =
  | { kind: "local"; id: string }
  | { kind: "relay"; id: string; relay: string[] };

/** The moves on this computer. A missing file is no moves; a broken one is reported and read as no moves. */
export function readLeadMoves(home: string, onError?: (error: unknown) => void): LeadMove[] {
  let raw: string;
  try {
    raw = readFileSync(path.join(home, LEAD_MOVES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError?.(error);
    return [];
  }
  try {
    return LeadMovesSchema.parse(JSON.parse(raw)).moves;
  } catch (error) {
    onError?.(error);
    return [];
  }
}

/** Where a notice for `leadId` goes now. Follows a chain of moves (a lead that moved twice), at most 8 steps. */
export function leadMoveTarget(
  moves: readonly LeadMove[],
  leadId: string,
  localServerId: string | null,
): LeadMoveTarget | null {
  let id = leadId;
  let last: LeadMove | null = null;
  for (let step = 0; step < 8; step++) {
    const next = moves.find((move) => move.from === id);
    if (!next) break;
    last = next;
    id = next.to;
    if (next.server && next.server !== localServerId) break;
  }
  if (!last) return null;
  if (!last.server || last.server === localServerId) return { kind: "local", id };
  if (!last.relay) return null;
  return { kind: "relay", id, relay: last.relay };
}

/** Runs the relay command with no shell. The text goes in a private temporary file, so no quoting can cut it. */
export async function relayLeadNotice(
  target: { id: string; relay: readonly string[] },
  text: string,
  run: (file: string, args: string[]) => Promise<void> = execRelay,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "fulcra-lead-move-"));
  const file = path.join(dir, "notice.txt");
  try {
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, {
      mode: 0o600,
    });
    const argv = target.relay.map((part) =>
      part.replaceAll("{id}", target.id).replaceAll("{file}", file),
    );
    await run(argv[0]!, argv.slice(1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function execRelay(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      error.message = `${error.message}: ${String(stderr).trim()}`;
      reject(error);
    });
  });
}

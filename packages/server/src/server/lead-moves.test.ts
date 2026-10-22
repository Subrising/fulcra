import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  LEAD_MOVES_FILE,
  leadMoveTarget,
  readLeadMoves,
  relayLeadNotice,
  type LeadMove,
} from "./lead-moves.js";

const OLD = "d2f99fe0-0000-4000-8000-000000000001";
const MID = "aaaaaaaa-0000-4000-8000-000000000002";
const NEW = "b3482a27-5461-4dc1-893f-12539c668ed5";
const PCSEND = ["/opt/fulcra/bin/pcsend", "{id}", "{file}"];

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("lead moves (FU-444)", () => {
  test("a lead moved on this computer is a local target; one on another computer uses its relay", () => {
    const local: LeadMove[] = [{ from: OLD, to: NEW }];
    expect(leadMoveTarget(local, OLD, "srv_mini")).toEqual({
      kind: "local",
      id: NEW,
    });
    const remote: LeadMove[] = [{ from: OLD, to: NEW, server: "srv_pc", relay: PCSEND }];
    expect(leadMoveTarget(remote, OLD, "srv_mini")).toEqual({
      kind: "relay",
      id: NEW,
      relay: PCSEND,
    });
    // On the new lead's own computer the same entry is local.
    expect(leadMoveTarget(remote, OLD, "srv_pc")).toEqual({
      kind: "local",
      id: NEW,
    });
    expect(leadMoveTarget(remote, NEW, "srv_mini")).toBeNull();
  });

  test("a lead that moved twice follows the chain; a remote move with no relay is no target", () => {
    const moves: LeadMove[] = [
      { from: OLD, to: MID },
      { from: MID, to: NEW, server: "srv_pc", relay: PCSEND },
    ];
    expect(leadMoveTarget(moves, OLD, "srv_mini")).toMatchObject({
      kind: "relay",
      id: NEW,
    });
    expect(leadMoveTarget([{ from: OLD, to: NEW, server: "srv_pc" }], OLD, "srv_mini")).toBeNull();
  });

  test("a missing file is no moves; a broken file is reported and read as no moves", () => {
    const home = mkdtempSync(join(tmpdir(), "lead-moves-"));
    homes.push(home);
    const errors: unknown[] = [];
    expect(readLeadMoves(home, (error) => errors.push(error))).toEqual([]);
    expect(errors).toEqual([]);
    writeFileSync(
      join(home, LEAD_MOVES_FILE),
      JSON.stringify({ version: 1, moves: [{ from: "x" }] }),
    );
    expect(readLeadMoves(home, (error) => errors.push(error))).toEqual([]);
    expect(errors).toHaveLength(1);
    writeFileSync(
      join(home, LEAD_MOVES_FILE),
      JSON.stringify({ version: 1, moves: [{ from: OLD, to: NEW }] }),
    );
    expect(readLeadMoves(home)).toEqual([{ from: OLD, to: NEW }]);
  });

  test("the relay gets the new id and a file with the full text, and the file is removed after", async () => {
    const text = `DONE "quoted" & <angle> %PATH% 'single'\nline two ${"x".repeat(5000)}`;
    let seen: { file: string; args: string[]; body: string } | null = null;
    await relayLeadNotice({ id: NEW, relay: PCSEND }, text, async (file, args) => {
      seen = { file, args, body: readFileSync(args[1]!, "utf8") };
    });
    expect(seen!.file).toBe(PCSEND[0]);
    expect(seen!.args[0]).toBe(NEW);
    expect(seen!.body).toBe(`${text}\n`);
    expect(() => readFileSync(seen!.args[1]!)).toThrow();
  });
});

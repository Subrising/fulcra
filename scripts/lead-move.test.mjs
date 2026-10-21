import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chatsReportingTo, gateLists, parseArgs, replaceFile, withMove } from "./lead-move.mjs";

const OLD = "d2f99fe0-0000-4000-8000-000000000001";
const NEW = "b3482a27-5461-4dc1-893f-12539c668ed5";

test("parseArgs keeps every relay value up to the next option", () => {
  const args = parseArgs([
    "forward",
    "--old",
    OLD,
    "--relay",
    "pcsend",
    "{id}",
    "{file}",
    "--new",
    NEW,
  ]);
  assert.deepEqual(args._, ["forward"]);
  assert.deepEqual(args.relay, ["pcsend", "{id}", "{file}"]);
  assert.equal(args.new, NEW);
});

test("withMove keeps one entry per old lead and drops a move away from the new lead", () => {
  const moves = withMove(
    [
      { from: OLD, to: "x" },
      { from: NEW, to: OLD },
    ],
    { from: OLD, to: NEW },
  );
  assert.deepEqual(moves, [{ from: OLD, to: NEW }]);
});

test("gateLists adds the new lead once, routes the workers and removes the old ids", () => {
  const next = gateLists(
    { leads: `d2f99fe0\n88b1e035\n`, routes: `d2f99fe0 mini\nabcd1234 air\n` },
    {
      lead: "b3482a27",
      drop: [OLD],
      workers: [{ id: "abcd1234", host: "mini" }],
    },
  );
  assert.equal(next.leads, "88b1e035\nb3482a27\n");
  assert.equal(next.routes, "abcd1234 mini\n");
  assert.equal(gateLists({ leads: next.leads, routes: "" }, { lead: NEW }).leads, next.leads);
});

test("replaceFile keeps a backup of the old file and writes the new text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-move-"));
  try {
    const file = path.join(dir, "list.txt");
    fs.writeFileSync(file, "old\n");
    replaceFile(file, "new\n", "stamp");
    assert.equal(fs.readFileSync(file, "utf8"), "new\n");
    assert.equal(fs.readFileSync(`${file}.bak-fu444-stamp`, "utf8"), "old\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chatsReportingTo finds live chats on the old lead by full or short id only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lead-move-home-"));
  try {
    const dir = path.join(home, "agents", "project");
    fs.mkdirSync(dir, { recursive: true });
    const chat = (id, labels, extra = {}) =>
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, labels, ...extra }));
    chat("a", { "fulcra.reports-to": OLD });
    chat("b", { "fulcra.reports-to": "d2f99fe0" });
    chat("c", { "fulcra.reports-to": `${OLD}@srv_mini` });
    chat("d", { "fulcra.reports-to": NEW });
    chat("e", { "fulcra.reports-to": OLD }, { archivedAt: "2026-10-21T00:00:00Z" });
    chat("f", { parent: "d2f99fe0" });
    assert.deepEqual(chatsReportingTo(home, OLD).sort(), ["a", "b", "c"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

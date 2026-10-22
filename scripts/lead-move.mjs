#!/usr/bin/env node
// FU-444: the supported way to move a project lead to a new chat, on the same computer or another one.
// Run each step on the computer it names; the order is in docs/lead-move.md. Every step only adds or replaces its own
// record, keeps a dated backup of each file it changes, and prints what it did. Nothing here archives a chat.
//
// The Leads sidebar seat is not a step here: the controller takes team writes only from the app's Team page
// (see docs/lead-move.md).
//   forward  --old <old id> --new <new id> [--server <server id> --relay <argv ...>]
//                                                          every computer with the old lead's workers: notices for the
//                                                          old lead go to the new one ({id} and {file} in the relay argv)
//   relabel  --old <old id> --new <new id> [--paseo <cli>]  new lead's computer: its own chats that report to the old
//                                                          lead report to the new one
//   routes   --lead <new id> --drop <old id ...> [--worker <id>=mini|air ...] [--dir <gate dir>]
//                                                          Mini: the PC gate allow-list and route list
//   send     <lead id> [--file <path>] [--relay <argv ...>] [--paseo <cli>]
//                                                          one command, full text (stdin or --file), to a lead here or on
//                                                          another computer
//   status                                                 this computer: server id and lead moves
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    // --relay and --drop and --worker take every value up to the next option.
    if (["relay", "drop", "worker"].includes(key)) {
      const values = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) values.push(argv[++i]);
      out[key] = [...(out[key] ?? []), ...values];
    } else out[key] = argv[++i];
  }
  return out;
}

/** The daemon home: --home, else PASEO_HOME, else the desktop app's home, else ~/.paseo. */
export function daemonHome(args, env = process.env, platform = process.platform) {
  if (args.home) return args.home;
  if (env.PASEO_HOME) return env.PASEO_HOME;
  const appData =
    {
      win32: path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Orca"),
      darwin: path.join(os.homedir(), "Library", "Application Support", "Orca"),
    }[platform] ?? path.join(os.homedir(), ".config", "Orca");
  const desktop = path.join(appData, "daemon");
  return fs.existsSync(path.join(desktop, "server-id"))
    ? desktop
    : path.join(os.homedir(), ".paseo");
}

/** Write a file safely: a dated backup of the old one, the new text in a temporary file, then one rename. */
export function replaceFile(file, text, stamp = new Date().toISOString().replace(/[:.]/g, "")) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-fu444-${stamp}`);
  const temp = `${file}.new-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The lead-moves.json entries after this move: one entry per old lead, the newest wins. */
export function withMove(moves, move) {
  return [...moves.filter((m) => m.from !== move.from && m.from !== move.to), move];
}

/** The gate lists after a move: the new lead is allowed, the workers are routed, the old ids are gone. */
export function gateLists(lists, { lead, drop = [], workers = [] }) {
  const gone = (line) => {
    const id = line.trim().split(/\s+/)[0] ?? "";
    return drop.some((old) => id && (old.startsWith(id) || id.startsWith(old.slice(0, 8))));
  };
  const keep = (text) =>
    text
      .split("\n")
      .filter((line) => line.trim() && !gone(line))
      .map((line) => line.trimEnd());
  const leadLines = keep(lists.leads);
  const short = lead.slice(0, 8);
  if (!leadLines.some((line) => line.trim().split(/\s+/)[0]?.startsWith(short)))
    leadLines.push(lead);
  const routeLines = keep(lists.routes).filter(
    (line) => !workers.some((w) => line.trim().split(/\s+/)[0] === w.id),
  );
  for (const w of workers) routeLines.push(`${w.id} ${w.host}`);
  return {
    leads: `${leadLines.join("\n")}\n`,
    routes: `${routeLines.join("\n")}\n`,
  };
}

/** The chats on this computer whose fulcra.reports-to is the old lead (full id or its first 8 characters). */
export function chatsReportingTo(home, oldId) {
  const dir = path.join(home, "agents");
  const out = [];
  for (const folder of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const sub = path.join(dir, folder);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const name of fs.readdirSync(sub)) {
      if (!name.endsWith(".json")) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(sub, name), "utf8"));
      } catch {
        continue;
      }
      const line = record?.labels?.["fulcra.reports-to"];
      if (record.archivedAt || typeof line !== "string") continue;
      const id = line.split("@")[0];
      if (id === oldId || (id.length === 8 && oldId.startsWith(id))) out.push(record.id);
    }
  }
  return out;
}

function fullId(id, what) {
  if (!UUID.test(id ?? "")) throw Error(`${what} must be a full chat id (36 characters)`);
  return id.toLowerCase();
}

function paseoCli(args) {
  return (args.paseo ?? (process.platform === "win32" ? "paseo.cmd" : "paseo")).split(" ");
}

function runPaseo(args, rest) {
  const [cmd, ...pre] = paseoCli(args);
  const home = daemonHome(args);
  return execFileSync(cmd, [...pre, ...rest, "--home", home], {
    encoding: "utf8",
    shell: process.platform === "win32" && cmd.endsWith(".cmd"),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function forward(args) {
  const home = daemonHome(args);
  const move = {
    from: fullId(args.old, "--old"),
    to: fullId(args.new, "--new"),
  };
  if (args.server) move.server = args.server;
  if (args.relay?.length) move.relay = args.relay;
  const local = fs.readFileSync(path.join(home, "server-id"), "utf8").trim();
  if (move.server && move.server !== local && !move.relay)
    throw Error("A lead on another computer needs --relay <argv ...> with {id} and {file}");
  const file = path.join(home, "lead-moves.json");
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).moves : [];
  replaceFile(file, `${JSON.stringify({ version: 1, moves: withMove(current, move) }, null, 2)}\n`);
  console.log(
    `Notices for ${move.from.slice(0, 8)} now go to ${move.to.slice(0, 8)}${
      move.server && move.server !== local ? ` on ${move.server} via ${move.relay[0]}` : " here"
    }.`,
  );
}

function relabel(args) {
  const home = daemonHome(args);
  const old = fullId(args.old, "--old");
  const next = fullId(args.new, "--new");
  const chats = chatsReportingTo(home, old).filter((id) => id !== next);
  for (const id of chats) {
    runPaseo(args, ["agent", "update", id, "--label", `fulcra.reports-to=${next}`]);
    console.log(`Chat ${id.slice(0, 8)} now reports to ${next.slice(0, 8)}.`);
  }
  if (!chats.length) console.log(`No chat here reports to ${old.slice(0, 8)}.`);
}

function routes(args) {
  const dir = args.dir ?? path.join(os.homedir(), ".config", "fulcra");
  const leadsFile = path.join(dir, "pc-notify-leads.txt");
  const routesFile = path.join(dir, "pc-notify-routes.txt");
  if (!ID.test(args.lead ?? "")) throw Error("--lead <id> is required");
  const workers = (args.worker ?? []).map((pair) => {
    const [id, host] = pair.split("=");
    if (!ID.test(id ?? "") || !["mini", "air"].includes(host ?? ""))
      throw Error(`--worker ${pair}: use <id>=mini or <id>=air`);
    return { id, host };
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  const next = gateLists(
    { leads: read(leadsFile), routes: read(routesFile) },
    { lead: args.lead, drop: args.drop ?? [], workers },
  );
  replaceFile(leadsFile, next.leads);
  replaceFile(routesFile, next.routes);
  console.log(
    `Gate allow-list: ${next.leads.trim().split("\n").length} leads. Routes: ${
      workers.length
    } added.`,
  );
}

function send(args) {
  const target = args._[1];
  if (!ID.test(target ?? "")) throw Error("send <lead id>: the id is required");
  const text = args.file ? fs.readFileSync(args.file, "utf8") : fs.readFileSync(0, "utf8");
  if (!text.trim()) throw Error("send: the message is empty");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-send-"));
  const file = path.join(dir, "message.txt");
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    let here = false;
    try {
      runPaseo(args, ["inspect", target]);
      here = true;
    } catch {}
    if (here) {
      runPaseo(args, ["send", target, "--prompt-file", file, "--no-wait"]);
      console.log(`Sent ${text.length} characters to ${target.slice(0, 8)} on this computer.`);
      return;
    }
    const relay = args.relay?.length ? args.relay : ["pcsend", "{id}", "{file}"];
    const argv = relay.map((part) => part.replaceAll("{id}", target).replaceAll("{file}", file));
    execFileSync(argv[0], argv.slice(1), { stdio: "inherit" });
    console.log(`Sent ${text.length} characters to ${target.slice(0, 8)} through ${argv[0]}.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function status(args) {
  const home = daemonHome(args);
  console.log(`Home: ${home}`);
  console.log(`Server id: ${fs.readFileSync(path.join(home, "server-id"), "utf8").trim()}`);
  const file = path.join(home, "lead-moves.json");
  for (const m of fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).moves : [])
    console.log(
      `Move ${m.from.slice(0, 8)} -> ${m.to.slice(0, 8)}${m.server ? ` on ${m.server}` : ""}`,
    );
}

const STEPS = { forward, relabel, routes, send, status };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const step = STEPS[args._[0]];
  if (!step) {
    console.error(`Use one of: ${Object.keys(STEPS).join(", ")}. See docs/lead-move.md.`);
    return 2;
  }
  try {
    await step(args);
    return 0;
  } catch (error) {
    console.error(`lead-move ${args._[0]}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

// Self-contained (no repo imports), so the one file can be copied to a computer that has no checkout.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  process.exitCode = await main();

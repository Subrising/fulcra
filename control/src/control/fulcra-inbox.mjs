#!/usr/bin/env node
// `fulcra inbox` (CONTRACTS v1.6 §3.5): the Fulcra inbox from a terminal or a direct Claude/Codex session.
//
//   fulcra inbox pair <code> [--session <session-id>]   pair this terminal (or a Fulcra session) with the code from the app
//   fulcra inbox list                                  what is waiting, numbered, plus updates on items already shown
//   fulcra inbox show <n>                              one item: a decision with its options, examples and recommendation
//   fulcra inbox answer <n> <option> [--note <text>] [--confirm]
//
// Every answer given here is recorded as the operator's (v1.6: typed text in a terminal or session cannot be told apart
// from an agent's in the same account), so it works only for decisions that start no work, and it is labelled
// "answered by the operator". v1.13 R3-2: a terminal answer needs an interactive terminal where the option number is
// typed again (a piped or agent-run answer is refused); a session channel's answer instead names the session's latest
// human input, which the controller checks against the session's human-log and timeline. The grant is this channel's own private file (grants/channel/<channelId>.json): it
// holds no operator secret and reaches only the channel methods, scoped by what the app allowed at pairing.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const uuid = (v) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function readGrant(file) {
  if (fs.realpathSync(file) !== file) throw Error("The channel grant path changed");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > 1024)
      throw Error("The channel grant file must be private to you");
    const g = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (g?.version !== 1 || !uuid(g.channelId) || !/^[A-Za-z0-9_-]{43}$/.test(g.capability))
      throw Error("Invalid channel grant");
    return g;
  } finally {
    fs.closeSync(fd);
  }
}
// The grant to use: an explicit file, else the only one in grants/channel. Never a guess between several.
export function grantPath(home, env = process.env) {
  if (env.ORCA_CHANNEL_FILE) return env.ORCA_CHANNEL_FILE;
  const dir = path.join(home, "grants", "channel");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))
    : [];
  if (files.length !== 1)
    throw Error(
      files.length
        ? "Several channels are paired here; set ORCA_CHANNEL_FILE to the one to use"
        : "Pair first: fulcra inbox pair <code from the Fulcra app>",
    );
  return path.join(dir, files[0]);
}
export function inboxClient({
  home,
  request,
  env = process.env,
  hostId = "fulcra-cli",
  confirmOption = async () => true,
}) {
  const bound = () => readGrant(grantPath(home, env));
  const call = (method, input) => {
    const g = bound();
    return request({
      method,
      input: { channelId: g.channelId, ...input },
      capability: g.capability,
    });
  };
  let kind = null;
  const itemAt = async (n) => {
    const listed = await call("cc-inbox-list", {});
    kind = listed.kind ?? null;
    const item = listed.items.find((i) => i.n === n);
    if (!item) throw Error("That number is not in the list any more; run fulcra inbox list again");
    return item;
  };
  return {
    async pair(code, sessionId) {
      if (!/^\d{6}$/.test(code ?? "")) throw Error("Use the 6-digit code shown in the Fulcra app");
      const r = await request({
        method: "cc-channel-pair",
        input: sessionId ? { code, sessionId } : { code, hostId },
      });
      const dir = path.join(home, "grants", "channel"),
        file = path.join(dir, `${r.channel.id}.json`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, channelId: r.channel.id, capability: r.capability }),
        { mode: 0o600, flag: "wx" },
      );
      return `Paired "${r.channel.label}". Answers from here are marked as answered by the operator.`;
    },
    async list() {
      return (await call("cc-inbox-list", {})).text;
    },
    async show(n) {
      return (await call("cc-inbox-show", { key: (await itemAt(n)).key })).text;
    },
    async answer(n, option, { note = "", confirm = false } = {}) {
      const item = await itemAt(n),
        shown = await call("cc-inbox-show", { key: item.key });
      if (!shown.decision) throw Error("Only decisions can be answered");
      const chosen = /^\d+$/.test(String(option))
        ? shown.decision.options.find((o) => o.n === Number(option))
        : shown.decision.options.find(
            (o) => o.id === option || o.title.toLowerCase() === String(option).toLowerCase(),
          );
      if (!chosen && !(shown.decision.options.length === 0 && option === "answer"))
        throw Error("Name one of the numbered options");
      if (shown.decision.bound)
        throw Error("This one starts work, so confirm it on your paired device in the Fulcra app");
      if (chosen?.destructive && !confirm)
        return `"${chosen.title}" is hard to undo. Run the same answer again with --confirm.`;
      // cli: an interactive terminal asks for the option number once more (§3.5 rule 2). session: the proof is the
      // session's own human input, checked by the controller.
      if (kind !== "session" && chosen && !(await confirmOption(chosen))) return "Not answered.";
      const r = await call("cc-inbox-answer", {
        key: item.key,
        optionId: chosen?.id ?? "answer",
        note,
        messageId: randomUUID(),
        expectedRevision: shown.decision.revision,
        confirmDestructive: chosen?.destructive === true && confirm,
        ...(kind === "session" ? { humanInput: "latest" } : {}),
      });
      return r.text;
    },
  };
}
export async function main(
  argv,
  {
    home,
    request,
    out = (s) => process.stdout.write(s + "\n"),
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) {
  const [verb, ...rest] = argv,
    flag = (name) => {
      const i = rest.indexOf(name);
      return i < 0 ? undefined : (rest.splice(i, name === "--confirm" ? 1 : 2)[1] ?? true);
    };
  const confirmOption = async (option) => {
    if (!stdin.isTTY)
      throw Error(
        "Answer from an interactive terminal: Fulcra asks you to type the option number again",
      );
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (
        (await rl.question(`Type ${option.n} to answer "${option.title}": `)).trim() ===
        String(option.n)
      );
    } finally {
      rl.close();
    }
  };
  const client = inboxClient({ home, request, confirmOption });
  if (verb === "pair") {
    const session = flag("--session");
    return out(await client.pair(rest[0], session));
  }
  if (verb === "list" || verb === undefined) return out(await client.list());
  if (verb === "show") return out(await client.show(Number(rest[0])));
  if (verb === "answer") {
    const confirm = flag("--confirm") === true,
      note = flag("--note");
    return out(
      await client.answer(Number(rest[0]), rest[1], {
        note: typeof note === "string" ? note : "",
        confirm,
      }),
    );
  }
  throw Error(
    "Usage: fulcra inbox [list | show <n> | answer <n> <option> [--note <text>] [--confirm] | pair <code> [--session <id>]]",
  );
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { controlHome } = await import("./home.mjs"),
    { request } = await import("./client.mjs");
  main(process.argv.slice(2), { home: controlHome(), request }).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  });
}

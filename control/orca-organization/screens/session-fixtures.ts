// Fictional step-through sessions (J6): one Claude and one Codex session in an invented project folder. Used by
// the server tests, the component tests and the screenshots. Nothing here is real session content.
//
// `fakeHost` answers the three host timeline calls from raw timeline entries the way the J5a host index does:
// turns group rows by turn id, file histories come from tool details, and paths are placed against the cwd.
import { placePath } from "../server/session-steps";

export const FIXTURE_CWD = "/work/tally";
export const FIXTURE_PROJECT = "20000000-0000-4000-8000-000000000020";
export const FIXTURE_TASK = "30000000-0000-4000-8000-000000000030";
export const CLAUDE_SESSION = "40000000-0000-4000-8000-000000000041";
export const CODEX_SESSION = "40000000-0000-4000-8000-000000000042";

type Entry = { provider: string; turnId: string; seqStart: number; seqEnd: number; timestamp: string; item: any };
const minute = (n: number) => new Date(Date.UTC(2026, 8, 24, 9, n)).toISOString();

function session(provider: string, turns: { turnId: string; items: any[] }[]): Entry[] {
  let seq = 0;
  return turns.flatMap(turn => turn.items.map(item => { seq += 1; return { provider, turnId: turn.turnId, seqStart: seq, seqEnd: seq, timestamp: minute(seq), item }; }));
}
const say = (text: string) => ({ type: "assistant_message", text });
const think = (text: string) => ({ type: "reasoning", text });
const ask = (text: string) => ({ type: "user_message", text, clientMessageId: `m-${text.length}` });
const tool = (callId: string, name: string, detail: any, status = "completed") => ({ type: "tool_call", callId, name, status, error: status === "failed" ? { message: "failed" } : null, detail });

export const CLAUDE_ENTRIES = session("claude", [
  { turnId: "claude-turn-1", items: [
    ask("Add a total row to the monthly report"),
    think("The report builder sums rows in the report module, so I will read it before changing anything."),
    tool("c-read", "Read", { type: "read", filePath: `${FIXTURE_CWD}/src/report.ts` }),
    say("I will add a total row after the monthly rows."),
    tool("c-edit", "Edit", { type: "edit", filePath: `${FIXTURE_CWD}/src/report.ts`, unifiedDiff: `--- ${FIXTURE_CWD}/src/report.ts\n+++ ${FIXTURE_CWD}/src/report.ts\n@@ -8,3 +8,4 @@\n   rows.push(month);\n }\n+rows.push(totalRow(rows));\n return rows;` }),
    tool("c-test", "Bash", { type: "shell", command: "npm test", output: " ✓ report totals\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)", exitCode: 0 }),
    say("The report now ends with a total row, and all 12 tests pass."),
  ] },
  { turnId: "claude-turn-2", items: [
    ask("Note the change in the changelog"),
    tool("c-write", "Write", { type: "write", filePath: `${FIXTURE_CWD}/CHANGELOG.md`, content: "## Unreleased\n- Monthly report ends with a total row" }),
    tool("c-notes", "Read", { type: "read", filePath: "/shared/notes/tally.md" }),
    say("Added a changelog entry."),
  ] },
  { turnId: "claude-turn-3", items: [ask("Anything left to do?"), say("No. The report and the changelog are both updated.")] },
]);

export const CODEX_ENTRIES = session("codex", [
  { turnId: "codex-turn-1", items: [
    ask("Split the amount parser out of the main parser"),
    think("Amount parsing is mixed into the main parser; moving it to its own file keeps both small."),
    tool("x-find", "shell", { type: "shell", command: "rg parseAmount src", output: "src/parse.ts:14:export function parseAmount(", exitCode: 0 }),
    tool("x-patch", "apply_patch", { type: "edit", filePath: "src/parse.ts", unifiedDiff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -12,6 +12,1 @@\n-export function parseAmount(text) {\n-  return Number(text.replace(',', ''));\n-}\n+export { parseAmount } from './parse-amount';",
      files: [
        { path: "src/parse.ts", kind: "update", unifiedDiff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -12,6 +12,1 @@\n-export function parseAmount(text) {\n-  return Number(text.replace(',', ''));\n-}\n+export { parseAmount } from './parse-amount';" },
        { path: "src/parse-amount.ts", kind: "add", unifiedDiff: "--- /dev/null\n+++ b/src/parse-amount.ts\n@@ -0,0 +1,3 @@\n+export function parseAmount(text) {\n+  return Number(text.replace(',', ''));\n+}" },
        { path: "/tmp/tally-scratch.txt", kind: "delete" },
      ] }),
    tool("x-test", "shell", { type: "shell", command: "npm test", output: " FAIL  parse-amount.test.ts > keeps negative amounts\n\n      Tests  1 failed | 11 passed (12)", exitCode: 1 }),
    say("One test fails: negative amounts lose their sign. I will fix that next."),
  ] },
  { turnId: "codex-turn-2", items: [
    ask("Fix the failing test"),
    think("The minus sign is dropped because the comma replace runs before the sign check."),
    tool("x-fix", "apply_patch", { type: "edit", filePath: "src/parse-amount.ts", unifiedDiff: "--- a/src/parse-amount.ts\n+++ b/src/parse-amount.ts\n@@ -1,3 +1,3 @@\n export function parseAmount(text) {\n-  return Number(text.replace(',', ''));\n+  return Number(text.replaceAll(',', ''));\n }" }),
    tool("x-retest", "shell", { type: "shell", command: "npm test", output: "      Tests  12 passed (12)", exitCode: 0 }),
    say("All 12 tests pass."),
  ] },
]);

const touchesOf = (detail: any): { path: string; kind: string }[] => {
  if (detail?.type === "read") return [{ path: detail.filePath, kind: "read" }];
  if (detail?.type === "write") return [{ path: detail.filePath, kind: "write" }];
  if ((detail?.type === "edit" || detail?.type === "unknown") && detail.files?.length)
    return detail.files.map((f: any) => ({ path: f.path, kind: detail.files.length > 1 ? "patch" : "edit" }));
  if (detail?.type === "edit") return [{ path: detail.filePath, kind: "edit" }];
  return [];
};

export type FakeHostOptions = { entries: Entry[]; cwd?: string; retained?: boolean; supported?: boolean; /** false: a host from before per-turn command counts. */ countsCommands?: boolean };

/** The host's timeline handle for one agent, answered from fixture entries. */
export function fakeHost({ entries, cwd = FIXTURE_CWD, retained = false, supported = true, countsCommands = true }: FakeHostOptions) {
  const calls: string[] = [];
  const refuse = () => Promise.reject(new Error("This needs a newer Fulcra host."));
  const turnIds = [...new Set(entries.map(e => e.turnId))];
  const history = new Map<string, { seq: number; turnId: string; kind: string; timestamp: string }[]>();
  const outside: { seq: number; turnId: string; kind: string; timestamp: string }[] = [];
  for (const e of entries) if (e.item.type === "tool_call") for (const t of touchesOf(e.item.detail)) {
    const path = placePath(t.path, cwd), touch = { seq: e.seqStart, turnId: e.turnId, kind: t.kind, timestamp: e.timestamp };
    if (path) history.set(path, [...(history.get(path) ?? []), touch]); else outside.push(touch);
  }
  return {
    calls,
    refetch: async (options: { turnId?: string }) => {
      calls.push(`refetch:${options.turnId ?? "all"}`);
      if (options.turnId && !supported) return refuse();
      const rows = entries.filter(e => !options.turnId || e.turnId === options.turnId);
      return { entries: rows, agent: retained ? null : { cwd }, retained, hasNewer: false, error: null };
    },
    turns: async ({ cursor = 0, limit = 50 }: { cursor?: number; limit?: number } = {}) => {
      calls.push(`turns:${cursor}`);
      if (!supported) return refuse();
      const all = turnIds.map(turnId => {
        const rows = entries.filter(e => e.turnId === turnId), tools = rows.filter(e => e.item.type === "tool_call");
        const files: string[] = [];
        let external = 0;
        for (const e of tools) for (const t of touchesOf(e.item.detail)) { const p = placePath(t.path, cwd); if (!p) external += 1; else if (!files.includes(p)) files.push(p); }
        return { turnId, implicit: false, seqStart: rows[0].seqStart, seqEnd: rows.at(-1)!.seqEnd, startedAt: rows[0].timestamp, endedAt: rows.at(-1)!.timestamp,
          toolCount: new Set(tools.map(e => e.item.callId)).size, files, externalFileCount: external,
          ...(!countsCommands ? {} : { commands: new Set(tools.filter(e => e.item.detail?.type === "shell").map(e => e.item.callId)).size }) };
      });
      const page = all.slice(cursor, cursor + limit);
      return { turns: page, totalTurns: all.length, nextCursor: cursor + page.length < all.length ? cursor + page.length : null, retained, epoch: "fixture", error: null };
    },
    fileHistory: async (path: string) => {
      calls.push(`file:${path}`);
      if (!supported) return refuse();
      const placed = placePath(path, cwd);
      return { path: placed, touches: placed ? history.get(placed) ?? [] : outside, retained, epoch: "fixture", error: null };
    },
  };
}

/** Controller enrollment rows for the two fixture sessions. */
export const FIXTURE_ENROLLMENT = [
  { id: CLAUDE_SESSION, task: FIXTURE_TASK, host: "mini", cwd: FIXTURE_CWD, mode: "delegated", generation: 1 },
  { id: CODEX_SESSION, task: FIXTURE_TASK, host: "mini", cwd: FIXTURE_CWD, mode: "delegated", generation: 1 },
];
export const FIXTURE_DIRECTORY = { membership: [{ taskId: FIXTURE_TASK, projectId: FIXTURE_PROJECT }] };

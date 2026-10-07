import { readFileAtCommit } from "../../utils/git-file-at-commit.js";
import { runGitCommand } from "../../utils/run-git-command.js";

// What a cheap model reads to say what one part of the code map does: the folder's file list and the start of a
// few entry files, all at the map's commit. Bounded so one summary stays one small call.

const MAX_LISTED = 200;
const MAX_IN_PROMPT = 60;
const ENTRY_FILES = 3;
const ENTRY_LINES = 80;
// Read whole (up to this size) and cut to the first lines: a large entry file still shows its top.
const ENTRY_BYTES = 262_144;
const ENTRY =
  /(^|\/)(index|main|mod|lib|app|server|__init__|README)\.[A-Za-z0-9]+$|(^|\/)README$|(^|\/)Cargo\.toml$|(^|\/)package\.json$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|swift|rb|cs|cpp|c|h)$/;
const TEST = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|_test\.|(^|\/)test_/;

export interface ModuleExcerpt {
  /** Entry files first (what "Open code" opens), then the rest in path order. */
  files: string[];
  text: string;
}

/** Entry files first, then the shortest source paths: usually the part's front door. Tests are skipped. */
export function pickEntryFiles(files: readonly string[]): string[] {
  const code = files.filter((f) => !TEST.test(f));
  const entries = code.filter((f) => ENTRY.test(f));
  const rest = code
    .filter((f) => SOURCE.test(f) && !ENTRY.test(f))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  return [...entries.sort((a, b) => a.length - b.length), ...rest].slice(0, ENTRY_FILES);
}

export async function readModuleExcerpt(input: {
  cwd: string;
  commit: string;
  folder: string;
}): Promise<ModuleExcerpt> {
  const listed = await runGitCommand(
    ["ls-tree", "-r", "--name-only", input.commit, "--", `${input.folder}/`],
    {
      cwd: input.cwd,
      envOverlay: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxOutputBytes: 1_048_576,
    },
  );
  const all = listed.stdout.split("\n").filter(Boolean);
  const parts = [`Files (${all.length}):`, ...all.slice(0, MAX_IN_PROMPT)];
  if (all.length > MAX_IN_PROMPT) parts.push(`… and ${all.length - MAX_IN_PROMPT} more`);
  const entries = pickEntryFiles(all);
  for (const path of entries) {
    const file = await readFileAtCommit({
      cwd: input.cwd,
      at: { kind: "commit", sha: input.commit },
      path,
      maxBytes: ENTRY_BYTES,
    });
    if (file.status !== "ok" || file.encoding !== "utf-8" || typeof file.content !== "string")
      continue;
    parts.push("", `--- ${path} (start) ---`, ...file.content.split("\n").slice(0, ENTRY_LINES));
  }
  const files = [...entries, ...all.filter((f) => !entries.includes(f))].slice(0, MAX_LISTED);
  return { files, text: all.length ? parts.join("\n") : "" };
}

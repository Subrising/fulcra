import fs from "node:fs/promises";
import path from "node:path";
import { CHILD_OUTPUT_LINE_LIMIT } from "../../../../utils/child-output-limit.js";

// Leave room for JSON response fields and escaping. Never modify a provider transcript.
export const CODEX_ROLLOUT_RESUME_LIMIT = CHILD_OUTPUT_LINE_LIMIT / 2;

/** Inspect file sizes before thread/resume can ask Codex to serialize its entire history. */
export async function assertCodexRolloutSize(home: string, threadId: string): Promise<void> {
  for (const directory of ["sessions", "archived_sessions"]) {
    const root = path.join(home, directory);
    let entries;
    try {
      entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(`-${threadId}.jsonl`)) continue;
      const stat = await fs.stat(path.join(entry.parentPath, entry.name));
      if (stat.size > CODEX_ROLLOUT_RESUME_LIMIT) {
        throw new Error(
          `Codex history too large to resume (${stat.size} bytes; limit ${CODEX_ROLLOUT_RESUME_LIMIT}); start a new session`,
        );
      }
    }
  }
}

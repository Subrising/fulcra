import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_FROM_STDIN, readPromptFile } from "./prompt-file.js";

// A brief with the parts cmd.exe mangles on a command line: line breaks, quotes, % and ! and carets.
const HARD_BRIEF = 'Line one\r\nSay "hello" and \'bye\'\n100% of %PATH% and ^caret & pipe | !bang!\n\nLast line';

describe("readPromptFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-file-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a multi-line file with quotes, percent signs and line breaks unchanged", async () => {
    const path = join(dir, "brief.txt");
    await writeFile(path, HARD_BRIEF, "utf8");
    expect(await readPromptFile(path)).toBe(HARD_BRIEF);
  });

  it("drops a leading byte order mark but keeps the rest", async () => {
    const path = join(dir, "bom.txt");
    await writeFile(path, `﻿${HARD_BRIEF}`, "utf8");
    expect(await readPromptFile(path)).toBe(HARD_BRIEF);
  });

  it("reads standard input when the path is -", async () => {
    const stdin = Readable.from([Buffer.from("first\nsecond "), Buffer.from('"third" 50%')]);
    expect(await readPromptFile(PROMPT_FROM_STDIN, stdin)).toBe('first\nsecond "third" 50%');
  });

  it("reports a missing file as PROMPT_FILE_READ_ERROR with the path", async () => {
    const path = join(dir, "missing.txt");
    await expect(readPromptFile(path)).rejects.toMatchObject({
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${path}`,
    });
  });

  it("reports a failing standard input as PROMPT_FILE_READ_ERROR", async () => {
    const stdin = Readable.from(
      (async function* () {
        yield "partial";
        throw new Error("pipe closed");
      })(),
    );
    await expect(readPromptFile(PROMPT_FROM_STDIN, stdin)).rejects.toMatchObject({
      code: "PROMPT_FILE_READ_ERROR",
      details: "pipe closed",
    });
  });
});

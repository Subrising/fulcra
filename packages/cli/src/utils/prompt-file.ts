import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandError } from "../output/index.js";

/** Pass `-` as the path to read the prompt from standard input. */
export const PROMPT_FROM_STDIN = "-";

async function readStdin(stdin: AsyncIterable<Buffer | string> = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a prompt from a UTF-8 file, or from standard input when the path is `-`.
 * A leading byte order mark is dropped: Windows editors and PowerShell add one, and it would reach the agent as text.
 * This exists because a Windows launch through paseo.cmd and cmd.exe cuts an argument at its first line break.
 */
export async function readPromptFile(
  path: string,
  stdin?: AsyncIterable<Buffer | string>,
): Promise<string> {
  try {
    const text =
      path === PROMPT_FROM_STDIN ? await readStdin(stdin) : await readFile(resolve(path), "utf8");
    return text.replace(/^﻿/, "");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${path}`,
      details: message,
    };
    throw error;
  }
}

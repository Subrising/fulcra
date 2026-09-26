import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckoutFileAtCommitGetRequest } from "@getpaseo/protocol/messages";
import { FileAtCommitInputError, type readFileAtCommit } from "../../utils/git-file-at-commit.js";
import { handleFileAtCommitRequest } from "./file-at-commit-request.js";

const SERVED = path.join(homedir(), "fixture-workspace");

function request(
  overrides: Partial<CheckoutFileAtCommitGetRequest> = {},
): CheckoutFileAtCommitGetRequest {
  return {
    type: "checkout.file-at-commit.get.request",
    requestId: "r1",
    cwd: SERVED,
    at: { kind: "commit", sha: "a".repeat(40) },
    path: "docs/map.json",
    ...overrides,
  };
}

function recordingRead(result?: Awaited<ReturnType<typeof readFileAtCommit>>, error?: Error) {
  const calls: Array<Parameters<typeof readFileAtCommit>[0]> = [];
  const read = (async (input: Parameters<typeof readFileAtCommit>[0]) => {
    calls.push(input);
    if (error) throw error;
    return result!;
  }) as typeof readFileAtCommit;
  return { calls, read };
}

describe("checkout.file-at-commit.get handler", () => {
  it("refuses a cwd that is not a served workspace, without reading anything", async () => {
    const { calls, read } = recordingRead();
    for (const cwd of ["/", "/tmp", `${SERVED}/..`, `${SERVED}-other`, "   "]) {
      const payload = await handleFileAtCommitRequest({
        msg: request({ cwd }),
        listWorkspaceCwds: async () => [SERVED],
        read,
      });
      expect(payload).toMatchObject({ status: "error", encoding: "none", commit: null });
    }
    expect(calls).toEqual([]);
  });

  it("reads in a served workspace, matched after ~ expansion and trailing slashes", async () => {
    const ok = {
      commit: "a".repeat(40),
      status: "ok" as const,
      encoding: "utf-8" as const,
      content: "{}",
      size: 2,
    };
    const { calls, read } = recordingRead(ok);
    const payload = await handleFileAtCommitRequest({
      msg: request({ cwd: "~/fixture-workspace/", maxBytes: 10 }),
      listWorkspaceCwds: async () => [SERVED],
      read,
    });
    expect(payload).toEqual({
      requestId: "r1",
      cwd: "~/fixture-workspace/",
      path: "docs/map.json",
      ...ok,
    });
    expect(calls).toEqual([
      {
        cwd: SERVED,
        at: { kind: "commit", sha: "a".repeat(40) },
        path: "docs/map.json",
        maxBytes: 10,
      },
    ]);
  });

  it("returns the host's own validation message, and nothing from other failures", async () => {
    const invalid = await handleFileAtCommitRequest({
      msg: request(),
      listWorkspaceCwds: async () => [SERVED],
      read: recordingRead(
        undefined,
        new FileAtCommitInputError("sha must be a 40-character lower-case commit id"),
      ).read,
    });
    expect(invalid).toMatchObject({
      status: "error",
      error: "sha must be a 40-character lower-case commit id",
    });
    const failed = await handleFileAtCommitRequest({
      msg: request(),
      listWorkspaceCwds: async () => [SERVED],
      read: recordingRead(undefined, new Error("fatal: /private/internal/path unreadable")).read,
    });
    expect(failed).toMatchObject({ status: "error", error: "The file could not be read" });
  });
});

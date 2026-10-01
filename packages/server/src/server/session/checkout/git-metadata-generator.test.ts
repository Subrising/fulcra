import { describe, expect, it } from "vitest";
import {
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
} from "../../agent/agent-response-loop.js";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { createGitAiDraftHelp } from "./git-ai-draft-help.js";
import {
  createGitMetadataGenerator,
  type StructuredTextGeneration,
  type StructuredTextGenerationRequest,
} from "./git-metadata-generator.js";

type DiffSource = Pick<WorkspaceGitService, "getCheckoutDiff" | "resolveRepoRoot">;

function createDiffSource(result: CheckoutDiffResult) {
  const diffCalls: Array<{ cwd: string; options: CheckoutDiffCompare }> = [];
  const diffSource: DiffSource = {
    getCheckoutDiff: async (cwd, options) => {
      diffCalls.push({ cwd, options });
      return result;
    },
    // buildMetadataPrompt reads paseo.json overrides from here; an unknown root
    // means no override applies, so the default style is used.
    resolveRepoRoot: async () => "/tmp/git-metadata-generator-test-missing-root",
  };
  return { diffSource, diffCalls };
}

function createGeneration(handler: (request: StructuredTextGenerationRequest<unknown>) => unknown) {
  const generateCalls: Array<StructuredTextGenerationRequest<unknown>> = [];
  const generation: StructuredTextGeneration = {
    generate: async <T>(request: StructuredTextGenerationRequest<T>): Promise<T> => {
      generateCalls.push(request as StructuredTextGenerationRequest<unknown>);
      return handler(request as StructuredTextGenerationRequest<unknown>) as T;
    },
  };
  return { generation, generateCalls };
}

const DIFF_WITH_ONE_FILE: CheckoutDiffResult = {
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+added\n",
  structured: [
    {
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      hunks: [],
      status: "ok",
    },
  ],
};

describe("createGitMetadataGenerator", () => {
  it("generateCommitMessage returns the generated message from an uncommitted-diff prompt", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      message: "Fix the flaky retry test",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const message = await generator.generateCommitMessage("/repo");

    expect(message).toBe("Fix the flaky retry test");
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      schemaName: "CommitMessage",
      agentTitle: "Commit generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a concise git commit message");
    expect(generateCalls[0].prompt).toContain("M\tsrc/foo.ts\t(+3 -1)");
    expect(generateCalls[0].prompt).toContain("diff --git a/src/foo.ts");
  });

  it("generateCommitMessage falls back to a default message when generation exhausts its providers", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage falls back when the generated response cannot be validated", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentResponseError("invalid", {
        lastResponse: "{}",
        validationErrors: ["message: required"],
      });
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).resolves.toBe("Update files");
  });

  it("generateCommitMessage rethrows errors that are not structured-generation failures", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new Error("network down");
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generateCommitMessage("/repo")).rejects.toThrow("network down");
  });

  it("generatePullRequestText returns the generated title and body from a base-diff prompt", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation, generateCalls } = createGeneration(() => ({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    }));
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    const result = await generator.generatePullRequestText("/repo", "main");

    expect(result).toEqual({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    });
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "base", baseRef: "main", includeStructured: true } },
    ]);
    expect(generateCalls[0]).toMatchObject({
      cwd: "/repo",
      schemaName: "PullRequest",
      agentTitle: "PR generator",
    });
    expect(generateCalls[0].prompt).toContain("Write a pull request title and body");
  });

  it("generatePullRequestText falls back to default PR text when generation fails", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_ONE_FILE);
    const { generation } = createGeneration(() => {
      throw new StructuredAgentFallbackError([]);
    });
    const generator = createGitMetadataGenerator({ workspaceGitService: diffSource, generation });

    await expect(generator.generatePullRequestText("/repo")).resolves.toEqual({
      title: "Update changes",
      body: "Automated PR generated by Fulcra.",
    });
  });
});

describe("Git AI draft help read-only caller seam", () => {
  function fixture(
    options: {
      denied?: boolean;
      patch?: string;
      failGeneration?: boolean;
      revokeAt?: number;
      moveAt?: number;
      metadataFailure?: boolean;
      message?: string;
      body?: string;
      advice?: string;
    } = {},
  ) {
    const calls: string[] = [];
    let authorizations = 0;
    const { diffSource, diffCalls } = createDiffSource({
      ...DIFF_WITH_ONE_FILE,
      diff: options.patch ?? DIFF_WITH_ONE_FILE.diff,
    });
    const { generation, generateCalls } = createGeneration(() => {
      calls.push("generate");
      if (options.failGeneration) throw new Error("private provider response body");
      return {
        advice: options.advice ?? "Inspect both sides and review the proposed edit before staging.",
      };
    });
    const help = createGitAiDraftHelp({
      authorizeCheckoutRead: async () => {
        calls.push("authorize");
        authorizations++;
        if (options.denied || authorizations === options.revokeAt)
          throw new Error("private admission details");
        return authorizations === options.moveAt ? "/changed-checkout" : "/admitted-checkout";
      },
      metadataGenerator: {
        generateCommitMessage: async (cwd) => {
          calls.push(`commit-draft:${cwd}`);
          if (options.metadataFailure) throw new StructuredAgentFallbackError([]);
          return options.message ?? "Fix checkout preview";
        },
        generatePullRequestText: async (cwd) => {
          calls.push(`pr-draft:${cwd}`);
          if (options.metadataFailure) throw new StructuredAgentFallbackError([]);
          return {
            title: "Fix checkout preview",
            body: options.body ?? "Keep suggestions separate from mutations.",
          };
        },
      },
      workspaceGitService: diffSource,
      generation,
    });
    return { help, calls, diffCalls, generateCalls };
  }

  it("authorizes the selected checkout before reusing commit and PR generators without writers", async () => {
    const { help, calls, diffCalls } = fixture();
    await expect(help.generate({ kind: "commit-message" })).resolves.toEqual({
      kind: "commit-message",
      message: "Fix checkout preview",
    });
    await expect(help.generate({ kind: "pull-request" })).resolves.toEqual({
      kind: "pull-request",
      title: "Fix checkout preview",
      body: "Keep suggestions separate from mutations.",
    });
    expect(calls).toEqual([
      "authorize",
      "authorize",
      "commit-draft:/admitted-checkout",
      "authorize",
      "authorize",
      "authorize",
      "pr-draft:/admitted-checkout",
      "authorize",
    ]);
    expect(diffCalls).toEqual([]);
  });

  it.each(["commit-message", "pull-request", "conflict-help"])(
    "denied %s cannot read or invoke a provider",
    async (kind) => {
      const { help, calls, diffCalls, generateCalls } = fixture({ denied: true });
      await expect(help.generate({ kind })).rejects.toThrow("Checkout read permission is required");
      expect(calls).toEqual(["authorize"]);
      expect(diffCalls).toEqual([]);
      expect(generateCalls).toEqual([]);
    },
  );

  it.each([
    { kind: "commit-message", cwd: "/arbitrary-checkout" },
    { kind: "conflict-help", path: "../../outside" },
    { kind: "pull-request", body: "caller-supplied provider context" },
    { kind: "conflict-help", providerOptions: { mode: "full-access" } },
    { kind: "force-push" },
    null,
  ])("rejects extra authority/context before admission: %j", async (request) => {
    const { help, calls } = fixture();
    await expect(help.generate(request)).rejects.toThrow("Invalid Git AI draft request");
    expect(calls).toEqual([]);
  });

  it("returns bounded conflict advice from the authenticated diff, not a file edit", async () => {
    const { help, calls, diffCalls, generateCalls } = fixture({ patch: "x".repeat(120_001) });
    await expect(help.generate({ kind: "conflict-help" })).resolves.toEqual({
      kind: "conflict-help",
      advice: "Inspect both sides and review the proposed edit before staging.",
    });
    expect(calls).toEqual([
      "authorize",
      "authorize",
      "authorize",
      "authorize",
      "generate",
      "authorize",
    ]);
    expect(diffCalls).toEqual([
      { cwd: "/admitted-checkout", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(generateCalls[0].prompt).toContain("do not run tools, edit files");
    expect(generateCalls[0].prompt).toContain("The diff is truncated");
    expect(generateCalls[0].prompt).toContain("x".repeat(120_000));
    expect(generateCalls[0].prompt).not.toContain("x".repeat(120_001));
    expect(generateCalls[0].schemaName).toBe("GitConflictHelp");
  });

  it("does not call a provider for an empty conflict diff", async () => {
    const { help, calls } = fixture({ patch: "  " });
    await expect(help.generate({ kind: "conflict-help" })).rejects.toThrow(
      "No readable changes are available for conflict help",
    );
    expect(calls).toEqual(["authorize", "authorize", "authorize"]);
  });

  it("does not forward provider error bodies", async () => {
    const { help } = fixture({ failGeneration: true });
    await expect(help.generate({ kind: "conflict-help" })).rejects.toThrow(
      /^Git AI draft could not be generated\. Try again\.$/,
    );
  });
  it.each([2, 3, 4, 5])(
    "current read revocation at check %s prevents conflict output",
    async (revokeAt) => {
      const { help, generateCalls } = fixture({ revokeAt });
      await expect(help.generate({ kind: "conflict-help" })).rejects.toThrow(
        "Checkout read permission is required",
      );
      expect(generateCalls).toHaveLength(revokeAt === 5 ? 1 : 0);
    },
  );

  it.each([2, 3])(
    "changed checkout at check %s cannot receive the old commit draft",
    async (moveAt) => {
      const { help } = fixture({ moveAt });
      await expect(help.generate({ kind: "commit-message" })).rejects.toThrow(
        "The selected checkout changed. Request a new draft.",
      );
    },
  );

  it.each(["commit-message", "pull-request"])(
    "strict %s failure cannot become fallback success",
    async (kind) => {
      const { help } = fixture({ metadataFailure: true });
      await expect(help.generate({ kind })).rejects.toThrow(
        "Git AI draft could not be generated. Try again.",
      );
    },
  );

  it.each([
    ["commit-message", { message: "x".repeat(73) }],
    ["pull-request", { body: "x".repeat(16_385) }],
    ["conflict-help", { advice: "x".repeat(16_385) }],
  ] as const)("rejects oversized %s output", async (kind, options) => {
    const { help } = fixture(options);
    await expect(help.generate({ kind })).rejects.toThrow(
      "Git AI draft could not be generated. Try again.",
    );
  });
});

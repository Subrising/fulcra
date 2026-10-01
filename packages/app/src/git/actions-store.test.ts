import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import { createGitAiDraftModel, type GitAiDraft, type GitAiTextDraft } from "./git-ai-draft-model";
import {
  __resetCheckoutGitActionsStoreForTests,
  useCheckoutGitActionsStore,
} from "@/git/actions-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("checkout-git-actions-store", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo/worktrees/feature";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("shares pending state per checkout and de-dupes in-flight calls", async () => {
    const deferred = createDeferred<unknown>();
    const client = {
      checkoutCommit: vi.fn(() => deferred.promise),
    };

    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    const store = useCheckoutGitActionsStore.getState();

    const first = store.commit({ serverId, cwd });
    const second = store.commit({ serverId, cwd });

    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("pending");

    deferred.resolve({});
    await Promise.all([first, second]);

    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("success");

    vi.advanceTimersByTime(1000);
    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("idle");
  });

  it("runs pull then push sequentially for pull-and-push", async () => {
    const order: string[] = [];
    const client = {
      checkoutPull: vi.fn(async () => {
        order.push("pull");
        return {};
      }),
      checkoutPush: vi.fn(async () => {
        order.push("push");
        return {};
      }),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd });

    expect(order).toEqual(["pull", "push"]);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("success");
  });

  it("does not push when pull fails for pull-and-push", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({ error: { message: "pull conflict" } })),
      checkoutPush: vi.fn(async () => ({})),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("pull conflict");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("surfaces push errors from pull-and-push after a successful pull", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({})),
      checkoutPush: vi.fn(async () => ({ error: { message: "push rejected" } })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("push rejected");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("refreshes git and GitHub state and reports success", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ success: true, error: null })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore.getState().refresh({ serverId, cwd });

    expect(client.checkoutRefresh).toHaveBeenCalledWith(cwd);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("success");
  });

  it("surfaces a refresh error and returns to idle", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ error: { message: "not a git repository" } })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(useCheckoutGitActionsStore.getState().refresh({ serverId, cwd })).rejects.toThrow(
      "not a git repository",
    );
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("idle");
  });

  it("discards selected paths through the shared checkout action workflow", async () => {
    const checkoutDiscardChanges = vi.fn(async () => ({ success: true, error: null }));
    const client = { checkoutDiscardChanges };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore
      .getState()
      .discardChanges({ serverId, cwd, paths: ["renamed.ts", "original.ts"] });

    expect(checkoutDiscardChanges).toHaveBeenCalledWith(cwd, {
      paths: ["renamed.ts", "original.ts"],
    });
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "discard-changes" }),
    ).toBe("success");
  });

  for (const rpc of [
    {
      label: "forge",
      method: "checkoutForgeSetAutoMerge",
      feature: "checkoutForgeSetAutoMerge",
    },
    {
      label: "legacy GitHub",
      method: "checkoutGithubSetAutoMerge",
      feature: "checkoutGithubSetAutoMerge",
    },
  ] as const) {
    it(`enables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore
        .getState()
        .enablePrAutoMerge({ serverId, cwd, method: "squash" });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, {
        enabled: true,
        method: "squash",
      });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-squash" }),
      ).toBe("success");
    });

    it(`disables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: false,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore.getState().disablePrAutoMerge({ serverId, cwd });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, { enabled: false });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "disable-pr-auto-merge" }),
      ).toBe("success");
    });
  }

  it("does not call PR auto-merge RPCs when the daemon lacks the feature flag", async () => {
    const client = {
      checkoutForgeSetAutoMerge: vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      })),
    };
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: {},
    });

    await expect(
      useCheckoutGitActionsStore.getState().enablePrAutoMerge({ serverId, cwd, method: "merge" }),
    ).rejects.toThrow("Update the host to use auto-merge actions.");

    expect(client.checkoutForgeSetAutoMerge).not.toHaveBeenCalled();
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-merge" }),
    ).toBe("idle");
  });
});

describe("Git AI preview and deliberate use", () => {
  it("generates only on request, edits locally and uses wording only on explicit action", async () => {
    const requestDraft = vi.fn(
      async (): Promise<GitAiDraft> => ({ kind: "commit-message", message: "Generated wording" }),
    );
    const onUseDraft = vi.fn();
    const model = createGitAiDraftModel({ requestDraft, onUseDraft });
    expect(requestDraft).not.toHaveBeenCalled();
    await model.request("commit-message");
    expect(onUseDraft).not.toHaveBeenCalled();
    model.edit("message", "Human reviewed wording");
    expect(onUseDraft).not.toHaveBeenCalled();
    model.useDraft();
    expect(onUseDraft).toHaveBeenCalledWith({
      kind: "commit-message",
      message: "Human reviewed wording",
    });
  });

  it("edits PR title and description without creating or publishing a PR", async () => {
    const onUseDraft = vi.fn();
    const model = createGitAiDraftModel({
      requestDraft: async () => ({
        kind: "pull-request",
        title: "Draft title",
        body: "Draft body",
      }),
      onUseDraft,
    });
    await model.request("pull-request");
    model.edit("title", "Reviewed title");
    model.edit("body", "Reviewed body");
    model.useDraft();
    expect(onUseDraft).toHaveBeenCalledWith({
      kind: "pull-request",
      title: "Reviewed title",
      body: "Reviewed body",
    });
  });

  it("deduplicates pending requests and cannot use a previous draft while generating", async () => {
    const deferred = createDeferred<GitAiDraft>();
    const requestDraft = vi.fn(() => deferred.promise);
    const onUseDraft = vi.fn();
    const model = createGitAiDraftModel({ requestDraft, onUseDraft });
    const pending = model.request("commit-message");
    await model.request("pull-request");
    model.useDraft();
    expect(requestDraft).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().phase).toBe("pending");
    expect(onUseDraft).not.toHaveBeenCalled();
    deferred.resolve({ kind: "commit-message", message: "Preview" });
    await pending;
    expect(model.getSnapshot().phase).toBe("ready");
  });

  it("conflict help has no apply callback", async () => {
    const onUseDraft = vi.fn();
    const model = createGitAiDraftModel({
      requestDraft: async () => ({ kind: "conflict-help", advice: "Review both sides" }),
      onUseDraft,
    });
    await model.request("conflict-help");
    model.useDraft();
    expect(onUseDraft).not.toHaveBeenCalled();
  });

  it("drops responses after checkout disposal even when the model is reactivated", async () => {
    const deferred = createDeferred<GitAiDraft>();
    const onUseDraft = vi.fn();
    const model = createGitAiDraftModel({ requestDraft: () => deferred.promise, onUseDraft });
    const pending = model.request("commit-message");
    model.dispose();
    model.activate();
    deferred.resolve({ kind: "commit-message", message: "Stale checkout wording" });
    await pending;
    expect(model.getSnapshot()).toEqual({ phase: "idle", draft: null, error: null });
    model.useDraft();
    expect(onUseDraft).not.toHaveBeenCalled();
  });

  it("shows a safe error and allows retry after provider failure", async () => {
    let fail = true;
    const model = createGitAiDraftModel({
      requestDraft: async () => {
        if (fail) throw new Error("private provider response body");
        return { kind: "commit-message", message: "Retry draft" };
      },
      onUseDraft: () => {},
    });
    await model.request("commit-message");
    expect(model.getSnapshot()).toEqual({
      phase: "error",
      draft: null,
      error: "Could not generate a draft. Try again.",
    });
    fail = false;
    await model.request("commit-message");
    expect(model.getSnapshot()).toEqual({
      phase: "ready",
      draft: { kind: "commit-message", message: "Retry draft" },
      error: null,
    });
  });

  it("does not use blank human-edited wording or a mismatched RPC response", async () => {
    const used: GitAiTextDraft[] = [];
    const model = createGitAiDraftModel({
      requestDraft: async () => ({ kind: "commit-message", message: "Draft" }),
      onUseDraft: (draft) => used.push(draft),
    });
    await model.request("commit-message");
    model.edit("message", "   ");
    model.useDraft();
    expect(used).toEqual([]);
    await model.request("pull-request");
    expect(model.getSnapshot().phase).toBe("error");
    model.useDraft();
    expect(used).toEqual([]);
  });
});

describe("explicit reviewed Git wording on separate human actions", () => {
  afterEach(() => {
    __resetCheckoutGitActionsStoreForTests();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });
  it("passes a reviewed subject only when the existing human commit action is invoked", async () => {
    const checkoutCommit = vi.fn(async () => ({}));
    const client = { checkoutCommit };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        reviewed: { client } as unknown as (typeof state.sessions)[string],
      },
    }));
    expect(checkoutCommit).not.toHaveBeenCalled();
    await useCheckoutGitActionsStore
      .getState()
      .commit({ serverId: "reviewed", cwd: "/selected", message: "Reviewed subject" });
    expect(checkoutCommit).toHaveBeenCalledExactlyOnceWith("/selected", {
      addAll: true,
      message: "Reviewed subject",
    });
  });
  it("passes reviewed PR wording without changing ordinary empty-option behavior", async () => {
    const checkoutPrCreate = vi.fn(async () => ({}));
    const client = { checkoutPrCreate };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        reviewed: { client } as unknown as (typeof state.sessions)[string],
      },
    }));
    await useCheckoutGitActionsStore.getState().createPr({
      serverId: "reviewed",
      cwd: "/selected",
      title: "Reviewed title",
      body: "Reviewed body",
    });
    expect(checkoutPrCreate).toHaveBeenCalledExactlyOnceWith("/selected", {
      title: "Reviewed title",
      body: "Reviewed body",
    });
  });
});

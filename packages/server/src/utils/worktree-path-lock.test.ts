import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  withWorktreeRemovalLock,
  withWorktreeUse,
  WorktreeInUseError,
} from "./worktree-path-lock.js";

// FU-679: the removal lock and the shared use holds. Most tests use fixed paths that do not exist.

function gate() {
  let open = () => {};
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return { open, opened };
}

test("a removal waits for a use inside its path, and a new use waits for the removal", async () => {
  const events: string[] = [];
  const firstUse = gate();
  const use = withWorktreeUse("/fixture-lock/root/tree/sub", async () => {
    events.push("use-start");
    await firstUse.opened;
    events.push("use-end");
  });
  const removalWork = gate();
  const removal = withWorktreeRemovalLock(["/fixture-lock/root/tree"], async () => {
    events.push("removal-start");
    await removalWork.opened;
    events.push("removal-end");
  });
  await Promise.resolve();
  const lateUse = withWorktreeUse("/fixture-lock/root/tree", async () => {
    events.push("late-use");
  });
  firstUse.open();
  await use;
  await new Promise((done) => setTimeout(done, 20));
  expect(events).toEqual(["use-start", "use-end", "removal-start"]);
  removalWork.open();
  await removal;
  await lateUse;
  expect(events).toEqual(["use-start", "use-end", "removal-start", "removal-end", "late-use"]);
});

test("a use outside the removal path does not wait", async () => {
  const removalWork = gate();
  const removal = withWorktreeRemovalLock(["/fixture-lock/b/tree"], () => removalWork.opened);
  await new Promise((done) => setTimeout(done, 5));
  expect(await withWorktreeUse("/fixture-lock/b/tree-other", async () => "ran")).toBe("ran");
  removalWork.open();
  await removal;
});

test("a removal gives up with WorktreeInUseError when a use does not finish in time", async () => {
  const useWork = gate();
  const use = withWorktreeUse("/fixture-lock/c/tree", () => useWork.opened);
  await expect(
    withWorktreeRemovalLock(["/fixture-lock/c/tree"], async () => "removed", 50),
  ).rejects.toBeInstanceOf(WorktreeInUseError);
  useWork.open();
  await use;
});

test("a use through a linked spelling of the path waits for the removal", async () => {
  const real = realpathSync(mkdtempSync(path.join(tmpdir(), "fu679-lock-")));
  const tree = path.join(real, "tree");
  mkdirSync(tree);
  const link = `${real}-link`;
  symlinkSync(real, link);
  try {
    const events: string[] = [];
    const removalWork = gate();
    const removal = withWorktreeRemovalLock([tree], async () => {
      events.push("removal");
      await removalWork.opened;
    });
    const use = withWorktreeUse(path.join(link, "tree"), async () => {
      events.push("use");
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(events).toEqual(["removal"]);
    removalWork.open();
    await removal;
    await use;
    expect(events).toEqual(["removal", "use"]);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("nested use of a covered path inside a held use does not wait for a removal", async () => {
  const outerWork = gate();
  let inner = "";
  const outer = withWorktreeUse("/fixture-lock/d/tree", async () => {
    await outerWork.opened;
    inner = await withWorktreeUse("/fixture-lock/d/tree/sub", async () => "ran");
  });
  const removal = withWorktreeRemovalLock(["/fixture-lock/d/tree"], async () => "removed", 2_000);
  await new Promise((done) => setTimeout(done, 20));
  outerWork.open();
  await outer;
  expect(inner).toBe("ran");
  expect(await removal).toBe("removed");
});

test("a callback that runs after its outer use ended waits for a removal", async () => {
  const events: string[] = [];
  let late: Promise<void> = Promise.resolve();
  const fired = gate();
  const lateUse = async () => {
    events.push("late");
  };
  const fireLater = () => {
    late = withWorktreeUse("/fixture-lock/e/tree/sub", lateUse);
    fired.open();
  };
  await withWorktreeUse("/fixture-lock/e/tree", async () => {
    setTimeout(fireLater, 30);
  });
  const removalWork = gate();
  const removal = withWorktreeRemovalLock(["/fixture-lock/e/tree"], async () => {
    events.push("removal");
    await removalWork.opened;
  });
  await fired.opened;
  await new Promise((done) => setTimeout(done, 20));
  expect(events).toEqual(["removal"]);
  removalWork.open();
  await removal;
  await late;
  expect(events).toEqual(["removal", "late"]);
});

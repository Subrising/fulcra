import { expect, test } from "vitest";
import { restartManagedDaemon, type RestartStatus } from "./managed-restart.js";

test("owned restart stops its captured lifetime then uses the app-managed launcher", async () => {
  const calls: string[] = [];
  const replacement: RestartStatus = { status: "running", ownedByDesktop: true };
  expect(
    await restartManagedDaemon({
      async status() {
        return { status: "running", ownedByDesktop: true };
      },
      async stopOwned() {
        calls.push("stop-owned");
        return { status: "stopped", ownedByDesktop: false };
      },
      async startManaged() {
        calls.push("start-managed");
        return replacement;
      },
    }),
  ).toBe(replacement);
  expect(calls).toEqual(["stop-owned", "start-managed"]);
});

test.each(["running", "starting", "errored"] as const)(
  "foreign or unknown %s state never stops or launches",
  async (status) => {
    let effects = 0;
    await expect(
      restartManagedDaemon({
        async status() {
          return { status, ownedByDesktop: false };
        },
        async stopOwned() {
          effects++;
          return { status: "stopped", ownedByDesktop: false };
        },
        async startManaged() {
          effects++;
          return { status: "running", ownedByDesktop: true };
        },
      }),
    ).rejects.toThrow(/refused|authenticated owner adoption/);
    expect(effects).toBe(0);
  },
);

test("a replaced or still-running supervisor cannot be followed by a second launch", async () => {
  let launches = 0;
  await expect(
    restartManagedDaemon({
      async status() {
        return { status: "running", ownedByDesktop: true };
      },
      async stopOwned() {
        return { status: "running", ownedByDesktop: false };
      },
      async startManaged() {
        launches++;
        return { status: "running", ownedByDesktop: true };
      },
    }),
  ).rejects.toThrow("managed launch refused");
  expect(launches).toBe(0);
});

// J3 test harness: the REAL controller Trackers module over a temporary journal, a tracker service and
// fake ports. Not a test file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlStore } from "../../../src/control/store.mjs";
import { Controller } from "../../../src/control/controller.mjs";
import { Trackers } from "../../../src/control/trackers.mjs";
import { rpc } from "../../../src/control/rpc.mjs";
import { createTrackerService } from "./service.mjs";
import { createGithubConnector } from "./github.mjs";
import { fakeFetch, fakeSecrets, githubRoutes, clock } from "./test-support.mjs";
export const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
export const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
export const TOKEN = "CANARY-svc-" + "y".repeat(24);
export function harness(
  t,
  { routes = githubRoutes(), token = TOKEN, file, secretValues, connectors } = {},
) {
  const dir = file
    ? path.dirname(file)
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-j3-svc-")));
  const journal = file ?? path.join(dir, "journal.sqlite");
  const store = new ControlStore(journal);
  const native = new Proxy(
    {},
    {
      get: () => () => {
        throw Error("Trackers must not invoke the native runtime");
      },
    },
  );
  const control = new Controller({
    store,
    native,
    authority: async () => ({ id: "task", delegationAuthority: [] }),
  });
  const source = {
    observedAt: "2026-09-23T00:00:00.000Z",
    available: true,
    partial: false,
    note: "test",
    projects: [P(1), P(2)].map((id, n) => ({
      id,
      name: `Project ${n}`,
      description: null,
      status: "in_progress",
    })),
    membership: [
      { taskId: T(1), projectId: P(1) },
      { taskId: T(2), projectId: P(2) },
    ],
  };
  control.trackers = new Trackers(control, async () => source);
  const dispatch = rpc(control, "op"),
    inputs = [];
  const controller = (method, input) => {
    inputs.push({ method, input });
    return dispatch({ method, input, operator: "op" });
  };
  const fetcher = fakeFetch(routes),
    secrets = fakeSecrets(secretValues ?? { "github.com:read": token }),
    now = clock();
  const service = createTrackerService({
    controller,
    connectors: {
      github: createGithubConnector({ fetcher, secrets }),
      ...(connectors ? connectors({ fetcher, secrets }) : {}),
    },
    now,
  });
  if (!file)
    t.after(() => {
      try {
        store.db.close();
      } catch {
        /* closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  return { service, fetcher, secrets, now, store, journal, dir, inputs, controller };
}
export const mapScratch = (service) =>
  service.map({
    projectId: P(1),
    tracker: "github",
    auth: "keychain",
    site: "github.com",
    remoteName: "Subrising/scratch",
    confirmRemoteId: "123456",
    expectedRevision: 0,
    note: "scratch",
  });

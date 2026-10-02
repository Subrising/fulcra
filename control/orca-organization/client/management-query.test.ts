import test from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { observedList } from "./management-query";
test("both controller and browser outages retain the same saved roles and observation time", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const key = ["orca-management"],
    saved = {
      status: "observed",
      message: "Saved state",
      observedAt: "2026-09-11T22:00:00Z",
      supervisors: [{ id: "retained supervisor" }],
      sessions: ["retained session"],
      deliveries: ["retained delivery"],
    };
  try {
    await client.fetchQuery({ queryKey: key, queryFn: () => observedList(async () => saved) });
    for (const load of [
      async () => ({ status: "error", message: "Controller socket unavailable" }),
      async () => {
        throw Error("Browser socket closed");
      },
    ]) {
      await assert.rejects(
        client.fetchQuery({ queryKey: key, queryFn: () => observedList(load) }),
        /socket/,
      );
      assert.deepEqual(client.getQueryData(key), saved);
      assert.equal(client.getQueryState(key)?.status, "error");
    }
  } finally {
    client.clear();
  }
});

import { retainRequestIdentity } from "./management-query";
test("confirmed refusals clear retry identity; lost replies and unrelated responses retain it", () => {
  const current = { id: "request-1", key: "same-scoped-input" };
  assert.equal(retainRequestIdentity(current, { status: "refused", messageId: current.id }), null);
  assert.equal(
    retainRequestIdentity(current, { status: "abandoned", messageId: current.id }),
    null,
  );
  for (const status of ["error", "uncertain", "intent", "delivered"])
    assert.equal(retainRequestIdentity(current, { status, messageId: current.id }), current);
  assert.equal(
    retainRequestIdentity(current, { status: "refused", messageId: "different-request" }),
    current,
  );
});

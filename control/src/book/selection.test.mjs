import test from "node:test";
import assert from "node:assert/strict";
import { bookSelection } from "./native.mjs";
const inventory = (models) => ({
  providers: { listModels: async (provider) => ({ provider, models }) },
});
const model = (id, extra = {}) => ({ provider: "claude", id, isSelectable: true, ...extra });
test("a booked Claude session with no model uses the worker default the host marks", async () => {
  const client = inventory([
    model("claude-big", { isDefault: true }),
    model("claude-small", { metadata: { workerDefault: true } }),
  ]);
  const r = await bookSelection(client, "claude", {}, "claude-enrolled");
  assert.equal(r.model, "claude-small");
  assert.deepEqual(r.fallback, []);
});
test("a booked Claude session keeps the enrolled model when the host marks no worker default", async () => {
  const r = await bookSelection(inventory([model("claude-big")]), "claude", {}, "claude-enrolled");
  assert.equal(r.model, "claude-enrolled");
});
test("a booked Claude session keeps the enrolled model when the model list fails", async () => {
  const client = {
    providers: {
      listModels: async () => {
        throw Error("down");
      },
    },
  };
  assert.equal(
    (await bookSelection(client, "claude", {}, "claude-enrolled")).model,
    "claude-enrolled",
  );
});
test("an explicit offered model beats the worker default", async () => {
  const client = inventory([
    model("claude-big"),
    model("claude-small", { metadata: { workerDefault: true } }),
  ]);
  const r = await bookSelection(client, "claude", { model: "claude-big" }, "claude-enrolled");
  assert.equal(r.model, "claude-big");
});
test("a Codex booking makes no model-list call without a forwarded value", async () => {
  const client = {
    providers: {
      listModels: async () => {
        throw Error("must not be called");
      },
    },
  };
  assert.equal((await bookSelection(client, "codex", {}, "gpt-6-astra")).model, "gpt-6-astra");
});

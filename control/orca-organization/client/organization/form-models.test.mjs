import test from "node:test";
import assert from "node:assert/strict";
import { openIntakeForm } from "./intake-form.ts";
import { openWorkspacesForm } from "./workspaces-form.ts";
test("a late prime reply cannot replace the human's explicit destination or lose its local draft", () => {
  const edits = [];
  const model = openIntakeForm({
    id: "one-request",
    text: "Plan",
    setText: (text) => edits.push(text),
  });
  const before = model.getState().choiceEpoch;
  model.setProject("chosen-project");
  model.setText("Plan Ship It");
  model.applyPrimeDestination("other-project", before);
  assert.equal(model.getState().projectKey, "chosen-project");
  assert.deepEqual(edits, ["Plan Ship It"]);
  model.close();
});
test("late defaults do not replace an explicitly selected model or thinking option", () => {
  const model = openIntakeForm({ id: "one-request", text: "Plan", setText() {} });
  model.setModel("codex/gpt-6.1-sol", "GPT-6.1 Sol");
  model.setThinking("high");
  model.applyDefaults("other/model", "low");
  assert.equal(model.getState().model, "codex/gpt-6.1-sol");
  assert.equal(model.getState().thinking, "high");
  model.close();
});
test("repeated snapshot/default values do not publish or reset owned input", () => {
  const model = openIntakeForm({ id: "one-request", text: "Plan", setText() {} });
  let publications = 0;
  model.subscribe(() => publications++);
  model.applyDefaults("codex/gpt-6.1-sol", "high");
  model.applyDefaults("codex/gpt-6.1-sol", "high");
  assert.equal(publications, 0);
  model.close();
});
test("workspace form pending actions prevent duplicate execution and expose failure in the same form", async () => {
  const model = openWorkspacesForm();
  let release;
  let writes = 0;
  const first = model.run(
    () =>
      new Promise((resolve) => {
        writes++;
        release = resolve;
      }),
  );
  await model.run(async () => writes++);
  assert.equal(writes, 1);
  release();
  await first;
  await model.run(async () => {
    throw Error("Refresh this company");
  });
  assert.equal(model.getState().notice, "Refresh this company");
  model.close();
});

const codexModes = [
  { id: "auto-review", label: "Auto review" },
  { id: "full-access", label: "Full access" },
];
const claudeModes = [
  { id: "default", label: "Ask" },
  { id: "acceptEdits", label: "Accept edits" },
];
test("cross-provider changes clear derived permission modes and resolve only supported provider choices", () => {
  const model = openIntakeForm({ id: "request", text: "Plan", setText() {} });
  model.applyDefaults("codex/gpt-6.1-sol", "high", "auto-review");
  model.setModel("claude/opus", "Claude");
  assert.equal(model.getState().modeId, "");
  model.applyProviderModes({ provider: "codex", modes: codexModes, configuredMode: "auto-review" });
  assert.equal(model.getState().modeId, "");
  model.applyProviderModes({
    provider: "claude",
    modes: claudeModes,
    configuredMode: "acceptEdits",
    defaultMode: "default",
  });
  assert.equal(model.getState().modeId, "acceptEdits");
  model.setModel("codex/gpt-6.1-sol");
  assert.equal(model.getState().modeId, "");
  model.applyProviderModes({
    provider: "codex",
    modes: codexModes,
    configuredMode: "acceptEdits",
    defaultMode: "auto-review",
  });
  assert.equal(model.getState().modeId, "auto-review");
  model.close();
});
test("explicit compatible mode survives model edits and late defaults, pending choices cannot restore an old provider mode", () => {
  const model = openIntakeForm({ id: "request", text: "Plan", setText() {} });
  model.setModel("claude/opus");
  model.setMode("default");
  model.applyDefaults("codex/gpt-6.1-sol", "high", "auto-review");
  model.applyProviderModes({ provider: "claude", modes: null, configuredMode: "acceptEdits" });
  assert.equal(model.getState().modeId, "default");
  model.applyProviderModes({
    provider: "claude",
    modes: claudeModes,
    configuredMode: "acceptEdits",
  });
  assert.equal(model.getState().modeId, "default");
  model.setModel("claude/sonnet");
  model.applyProviderModes({
    provider: "claude",
    modes: claudeModes,
    configuredMode: "acceptEdits",
  });
  assert.equal(model.getState().modeId, "default");
  model.setModel("codex/gpt-6.1-sol");
  model.applyProviderModes({ provider: "codex", modes: codexModes, defaultMode: "auto-review" });
  assert.equal(model.getState().modeId, "auto-review");
  model.close();
});

test("permission mode edits also fence late model/provider defaults", () => {
  const model = openIntakeForm({ id: "request", text: "Plan", setText() {} });
  model.setMode("full-access");
  model.applyDefaults("claude/opus", "medium", "acceptEdits");
  assert.equal(model.getState().model, "codex/gpt-6.1-sol");
  assert.equal(model.getState().modeId, "full-access");
  model.close();
});

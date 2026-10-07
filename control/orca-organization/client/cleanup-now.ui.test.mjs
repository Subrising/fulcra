// Settings → Clean-up with synthetic component adapters (not a Paseo/phone UI test): the automatic choices save one
// field at a time, and Clean up now previews first, then confirms with that preview's id and a fresh request id.
import { CleanupNowSection } from "./cleanup-now-view";
import { setHandler, calls } from "./ui-test-adapters.mjs";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const h = React.createElement;
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    accent: "#06f",
    accentForeground: "#fff",
    surface0: "#111",
  },
};
afterEach(() => cleanup());

const PREVIEW = "00000000-0000-4000-8000-000000000001";
const MB = 1048576;
const planned = [
  { id: "job-a", action: "archive", state: "planned", reason: "Website copy: finished", bytes: 0 },
  { id: "s-1", action: "reap", state: "planned", reason: "Docs lead: idle 5 hours", bytes: 0 },
  {
    id: "job-b",
    action: "worktree",
    state: "planned",
    reason: "Mobile fix: worktree and build output will be removed",
    bytes: 300 * MB,
  },
];
const reply = (value) => ({
  pending: false,
  operationId: "00000000-0000-4000-8000-000000000009",
  value: { version: 1, observedAt: "", partial: false, ...value },
});

function mount({ settings = {}, confirm } = {}) {
  let saved = { archiveFinished: false, idleMinutes: "never", retentionDays: 7, ...settings };
  setHandler(async (name, input) => {
    if (name === "organization.cleanup-settings") {
      saved = { ...saved, ...input };
      return saved;
    }
    if (name === "organization.cleanup-now" && !input.previewId)
      return reply({ previewId: PREVIEW, results: planned });
    if (name === "organization.cleanup-now") return confirm(input);
    throw Error(`unexpected ${name}`);
  });
  return render(h(CleanupNowSection, { theme }));
}

test("automatic choices load, then save only the field that changed", async () => {
  mount({ settings: { retentionDays: "never" } });
  await screen.findByRole("radio", { name: "1 day" });
  assert.ok(screen.getByText(/Keep-time is set to never, so job folders are not removed/));
  fireEvent.click(screen.getByRole("radio", { name: "1 day" }));
  // Choices are disabled while a save is in flight; the next one waits for it.
  await waitFor(() =>
    assert.equal(
      screen.getByRole("radio", { name: "1 day" }).getAttribute("aria-selected"),
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("radio", { name: "On" }));
  await waitFor(() => assert.equal(calls.length, 3));
  assert.deepEqual(
    calls.map((c) => c.input),
    [{}, { idleMinutes: 1440 }, { archiveFinished: true }],
  );
});

test("Clean up now previews without changing anything, then confirms that exact preview", async () => {
  mount({
    confirm: (input) =>
      reply({
        results: [
          { ...planned[0], state: "complete", reason: "Archived" },
          { ...planned[1], state: "complete", reason: "Closed" },
          { ...planned[2], state: "needs-attention", reason: "Mobile fix: 2 unpushed commits" },
        ],
      }),
  });
  await screen.findByRole("radio", { name: "Never" });
  fireEvent.click(screen.getByRole("button", { name: "Preview clean-up now" }));
  await screen.findByText("Archive 1 finished job");
  assert.ok(screen.getByText("Close 1 idle session (history and owner kept)"));
  assert.ok(screen.getByText("Remove 1 job folder · 300.0 MB"));
  assert.ok(screen.getByText("Docs lead: idle 5 hours"));
  const previews = calls.filter((c) => c.name === "organization.cleanup-now");
  assert.equal(previews.length, 1);
  assert.deepEqual(Object.keys(previews[0].input), ["requestId"]);

  fireEvent.click(screen.getByRole("button", { name: "Clean up these 3 items" }));
  await screen.findByText(
    "Done: 1 job archived, 1 idle session closed. 1 item was kept; see below.",
  );
  assert.ok(screen.getByText("Mobile fix: 2 unpushed commits"));
  const confirms = calls.filter((c) => c.name === "organization.cleanup-now" && c.input.previewId);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].input.previewId, PREVIEW);
  assert.notEqual(confirms[0].input.requestId, previews[0].input.requestId);
});

test("an expired preview says to preview again and returns to the start", async () => {
  mount({
    confirm: () => {
      throw Error("Preview expired; start again");
    },
  });
  await screen.findByRole("radio", { name: "Never" });
  fireEvent.click(screen.getByRole("button", { name: "Preview clean-up now" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clean up these 3 items" }));
  assert.match((await screen.findByRole("alert")).textContent, /more than 10 minutes old/);
  assert.ok(screen.getByRole("button", { name: "Preview clean-up now" }));
});

test("cancel drops the preview without calling the controller", async () => {
  mount({ confirm: () => assert.fail("must not confirm") });
  await screen.findByRole("radio", { name: "Never" });
  fireEvent.click(screen.getByRole("button", { name: "Preview clean-up now" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  assert.ok(screen.getByRole("button", { name: "Preview clean-up now" }));
  assert.equal(calls.filter((c) => c.name === "organization.cleanup-now").length, 1);
});

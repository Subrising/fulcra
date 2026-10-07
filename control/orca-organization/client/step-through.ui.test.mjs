// J6 step-through behaviour with synthetic component adapters (not a Paseo/phone UI test). The RPC double runs the
// real server shaping (server/session-steps.ts) over the fictional fixture sessions, so what the component steps
// through is what the plugin server would return.
// Private test configuration first: the server shaping names `mini` as this Mac, as the fixture sessions do.
import "../server/portable.fixture";
import { StepThrough } from "./step-through";
import { WhatItDidFooterView } from "./what-it-did-card";
import { createSessionSteps } from "../server/session-steps";
import {
  CLAUDE_ENTRIES,
  CLAUDE_SESSION,
  CODEX_ENTRIES,
  CODEX_SESSION,
  FIXTURE_DIRECTORY,
  FIXTURE_ENROLLMENT,
  fakeHost,
} from "../screens/session-fixtures";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setHandler, layoutHandlers, panResponders } from "./ui-test-adapters.mjs";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup, act } = await import("@testing-library/react");
const h = React.createElement;
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    accent: "#06f",
    accentForeground: "#fff",
    surface0: "#111",
    surface1: "#191f2a",
    surface2: "#263246",
    statusSuccess: "#6cb17b",
    statusWarning: "#c09664",
    statusDanger: "#d8847b",
  },
};
const clients = [];
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  panResponders.length = 0;
  layoutHandlers.clear();
});

let recoveryStatus = { compactionLoops: null };
function serve({ supported = true, codexEntries = CODEX_ENTRIES } = {}) {
  const hosts = {
    [CLAUDE_SESSION]: fakeHost({ entries: CLAUDE_ENTRIES, supported }),
    [CODEX_SESSION]: fakeHost({ entries: codexEntries, supported }),
  };
  const paseo = { agents: { ref: (id) => ({ timeline: hosts[id] }) } };
  const steps = createSessionSteps({
    call: async () => [],
    enrollment: async () => FIXTURE_ENROLLMENT,
    projects: async () => FIXTURE_DIRECTORY,
    bounded: (work) => work,
  });
  setHandler((name, input) => {
    if (name === "organization.session-turns") return steps.turns(input, paseo);
    if (name === "organization.session-step") return steps.step(input, paseo);
    if (name === "organization.session-file-history") return steps.fileHistory(input, paseo);
    if (name === "organization.trackers") return { items: [], links: [] };
    if (name === "organization.recovery")
      return { status: "observed", observedAt: new Date().toISOString(), recovery: recoveryStatus };
    throw Error(`unexpected read ${name}`);
  });
}
function mount(sessionId, layout = { compact: false, platform: "web" }, extra = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    h(
      QueryClientProvider,
      { client },
      h(StepThrough, {
        sessionId,
        theme,
        layout,
        host: { id: "mini", label: "This Mac" },
        provider: sessionId === CLAUDE_SESSION ? "claude" : "codex",
        taskTitle: "Monthly report totals",
        ...extra,
      }),
    ),
  );
}
const detail = () => screen.getByTestId("sessions-step-detail");
const showing = async (text) => waitFor(() => assert.match(detail().textContent, text));
const press = (label) => fireEvent.click(screen.getByRole("button", { name: label }));

test("V1: stepping walks turn → tool calls → files, crossing turns in both directions", async () => {
  serve();
  mount(CLAUDE_SESSION);
  await waitFor(() => assert(screen.getByTestId("sessions-scrubber")));
  await showing(/Read 1 file/);
  assert.match(detail().textContent, /read it before changing/);
  press("Next step");
  await showing(/Edited 1 file/);
  assert.match(detail().textContent, /WHYI will add a total row after the monthly rows\./);
  assert.match(
    screen.getByTestId("sessions-diff").textContent,
    /\+rows\.push\(totalRow\(rows\)\);/,
  );
  press("Next step");
  await showing(/Ran tests: 12 passed/);
  assert.match(detail().textContent, /\$ npm test/);
  press("Next step");
  await showing(/Wrote 1 file/);
  assert.match(screen.getByText(/^Turn 2 of 3/).textContent, /step 1 of 2/);
  press("Previous step");
  await showing(/Ran tests: 12 passed/);
  assert.match(screen.getByText(/^Turn 1 of 3/).textContent, /step 3 of 3/);
  fireEvent.click(screen.getByTestId("sessions-step-0"));
  await showing(/Read 1 file/);
});

test("V2: arrow keys step on the web, except while typing in the file filter", async () => {
  serve();
  mount(CLAUDE_SESSION);
  await showing(/Read 1 file/);
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  await showing(/Edited 1 file/);
  await act(async () => {
    screen
      .getByTestId("sessions-file-filter")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  assert.match(detail().textContent, /Edited 1 file/);
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
  });
  await showing(/Read 1 file/);
});

test("V3: a swipe on the step panel steps, and dragging along the scrubber picks a turn", async () => {
  serve();
  mount(CLAUDE_SESSION);
  await showing(/Read 1 file/);
  // React Native touch handlers read nativeEvent.pageX; drive them with the values a swipe produces, reading the
  // panel's current handlers before each gesture (a re-render replaces them).
  const swipe = async (from, to) => {
    const panel = detail().parentElement;
    const key = Object.keys(panel).find((k) => k.startsWith("__reactProps"));
    await act(async () => {
      panel[key].onTouchStart({ nativeEvent: { pageX: from } });
      panel[key].onTouchEnd({ nativeEvent: { pageX: to } });
    });
  };
  await swipe(300, 120);
  await showing(/Edited 1 file/);
  await swipe(120, 320);
  await showing(/Read 1 file/);
  await swipe(200, 180);
  await showing(/Read 1 file/);
  // Drag to the far end of the scrubber: the last turn.
  await act(async () => {
    layoutHandlers.get("sessions-scrubber")({ nativeEvent: { layout: { width: 300 } } });
  });
  const drag = panResponders.at(-1);
  await act(async () => {
    drag.onPanResponderMove({ nativeEvent: { locationX: 290 } }, { dx: 200 });
  });
  await waitFor(() => assert.match(screen.getByText(/^Turn 3 of 3/).textContent, /Turn 3/));
  assert.match(
    screen.getByText(/The agent answered without using any tools/).textContent,
    /without using any tools/,
  );
});

test('V4: "Only file changes" and "Every change to" narrow the scrubber and the steps', async () => {
  serve();
  mount(CLAUDE_SESSION);
  await showing(/Read 1 file/);
  assert(screen.getByTestId("sessions-turn-2"));
  press("Only file changes");
  await waitFor(() => assert.equal(screen.queryByTestId("sessions-turn-2"), null));
  await showing(/Edited 1 file/);
  assert.equal(screen.queryByTestId("sessions-step-0"), null, "the read step is hidden");
  press("Only file changes");
  await waitFor(() => assert(screen.getByTestId("sessions-turn-2")));
  press("Every change to src/report.ts");
  await waitFor(() =>
    assert.match(
      screen.getByText(/^Every change to src\/report\.ts:/).textContent,
      /1 change, 1 read\./,
    ),
  );
  await waitFor(() => assert.equal(screen.queryByTestId("sessions-turn-1"), null));
  await showing(/Read 1 file/);
  press("Next step");
  await showing(/Edited 1 file/);
  press("Next step");
  await showing(/Edited 1 file/);
  press("Show every step");
  await waitFor(() => assert(screen.getByTestId("sessions-turn-2")));
});

test('V8 (L38): a Codex turn that changed files only through commands is listed under "Only file changes", with the note', async () => {
  const row = (seq, turnId, item) => ({
    provider: "codex",
    turnId,
    seqStart: seq,
    seqEnd: seq,
    timestamp: `2026-09-25T09:00:0${seq}.000Z`,
    item,
  });
  const shell = (id, command) => ({
    type: "tool_call",
    callId: id,
    name: "shell",
    status: "completed",
    error: null,
    detail: { type: "shell", command, output: "", exitCode: 0 },
  });
  serve({
    codexEntries: [
      row(1, "build", { type: "user_message", text: "Write the release notes" }),
      row(2, "build", shell("c1", "printf 'a' > notes/a.md")),
      row(3, "build", shell("c2", "printf 'b' > notes/b.md")),
      row(4, "build", shell("c3", "printf 'c' > notes/c.md")),
    ],
  });
  mount(CODEX_SESSION);
  await waitFor(() => assert(screen.getByTestId("sessions-turn-0")));
  press("Only file changes");
  await waitFor(() =>
    assert.match(
      screen.getByTestId("sessions-turn-note").textContent,
      /^Ran 3 commands; changes made through commands are not listed\.$/,
    ),
  );
  assert.equal(screen.queryByText("No turn in this session changed a file."), null);
  await showing(/Ran a command/);
});

test("V5: a Codex session steps the same way, with the outside file only as outside", async () => {
  serve();
  mount(CODEX_SESSION);
  await showing(/Ran a command/);
  press("Next step");
  await showing(/Changed 2 files and 1 file outside the project/);
  const text = detail().textContent;
  assert.match(text, /Edited src\/parse\.ts/);
  assert.match(text, /Created src\/parse-amount\.ts/);
  assert.match(text, /Deleted a file outside the project/);
  assert.match(text, /Changes outside the project are not shown\./);
  assert(!text.includes("/tmp/"));
  assert.equal(screen.getAllByTestId("sessions-diff").length, 2);
  press("Next step");
  await showing(/Ran tests: 1 failed, 11 passed/);
  assert.match(detail().textContent, /Did not succeed/);
  assert.match(detail().textContent, /Finished with exit code 1/);
});

test("V6: an older host shows plain words, never a blank screen", async () => {
  serve({ supported: false });
  mount(CLAUDE_SESSION);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("sessions-unavailable").textContent,
      "This needs a newer Fulcra host.",
    ),
  );
  assert(screen.getByText(/Update Fulcra on this Mac/));
  assert.equal(screen.queryByTestId("sessions-scrubber"), null);
});

test("V7: on a phone the scrubber is a vertical step list with the steps under their turn", async () => {
  serve();
  mount(CLAUDE_SESSION, { compact: true, platform: "ios" });
  await showing(/Read 1 file/);
  const scrubber = screen.getByTestId("sessions-scrubber");
  assert.equal(JSON.parse(scrubber.getAttribute("data-native-style")).flexDirection, "column");
  assert(
    scrubber.contains(screen.getByTestId("sessions-step-2")),
    "steps sit inside the list, under their turn",
  );
  assert.match(
    screen.getByTestId("sessions-turn-0").getAttribute("aria-label"),
    /^Turn 1: Changed files · 3 steps$/,
  );
});

test("U5-D08: desktop turn buttons are readable numbers (the summary is their label and shown below); the step shows when it was recorded", async () => {
  serve();
  mount(CLAUDE_SESSION);
  await waitFor(() => assert(screen.getByTestId("sessions-scrubber")));
  await showing(/Read 1 file/);
  const first = screen.getByTestId("sessions-turn-0");
  assert.equal(first.textContent, "1");
  assert.match(first.getAttribute("aria-label"), /^Turn 1: .+/);
  assert.match(screen.getByTestId("sessions-step-time").textContent, /^Recorded .*\d{1,2}:\d{2}/);
});

test("V9: each turn opens with a plain What it did card; raw commands are one tap away", async () => {
  serve();
  mount(CLAUDE_SESSION);
  const card = () => screen.getByTestId("sessions-what-it-did");
  await waitFor(() => assert.match(card().textContent, /Ran tests: 12 passed/));
  const lines = screen.getAllByTestId("sessions-what-it-did-line").map((line) => line.textContent);
  assert.match(lines[0], /^1\. Read /);
  assert.ok(
    lines.some((line) => /^\d\. Changed .+ \(\+\d+ −\d+\)$/.test(line)),
    lines.join(" | "),
  );
  assert.equal(screen.getByTestId("sessions-what-it-did-tests").textContent, "Tests passed");
  assert.equal(screen.queryAllByTestId("sessions-what-it-did-command").length, 0);
  press("Show raw commands");
  assert.ok(
    screen
      .getAllByTestId("sessions-what-it-did-command")
      .some((c) => c.textContent === "$ npm test"),
  );
});

test("V10: beside a chat the view is named What it did and opens on the latest turn", async () => {
  serve();
  mount(CLAUDE_SESSION, { compact: true, platform: "web" }, { startAtLatest: true });
  await waitFor(() =>
    assert.match(screen.getByTestId("sessions-header").textContent, /WHAT IT DID/),
  );
  await waitFor(() => assert.ok(screen.getByText(/^Turn 3 of 3/)));
  await waitFor(() => assert.ok(screen.getByTestId("sessions-what-it-did")));
});

test("V11: under a chat turn the card folds to one line and opens on tap; a turn without tools shows nothing", async () => {
  const toolCalls = [
    {
      name: "Read",
      status: "completed",
      detail: { type: "read", filePath: "/work/app/report.ts" },
    },
    {
      name: "Bash",
      status: "completed",
      detail: { type: "shell", command: "npm test", output: "12 passed", exitCode: 0 },
    },
  ];
  render(h(WhatItDidFooterView, { toolCalls, durationMs: 19400, cwd: "/work/app", theme }));
  const line = screen.getByRole("button", { name: "Show what it did" });
  assert.equal(line.textContent, "▸ What it did · 2 steps · 19 s · Tests passed");
  assert.equal(screen.queryByTestId("sessions-what-it-did"), null);
  fireEvent.click(line);
  const lines = screen.getAllByTestId("sessions-what-it-did-line").map((node) => node.textContent);
  assert.deepEqual(lines, ["1. Read report.ts", "2. Ran tests: 12 passed"]);
  cleanup();
  const empty = render(
    h(WhatItDidFooterView, { toolCalls: [], durationMs: null, cwd: null, theme }),
  );
  assert.equal(empty.container.textContent, "");
});

test("V12: the step-through shows each fresh start in plain words, never the private handoff path", async () => {
  recoveryStatus = {
    compactionLoops: {
      freshStart: true,
      rotations: [
        {
          id: "r1",
          sessionId: CLAUDE_SESSION,
          state: "rotated",
          handoff: "/private/home/context-handoffs/r1.json",
          outcome: "rotated",
          at: Date.parse("2026-10-07T04:02:00.000Z"),
        },
      ],
    },
  };
  try {
    serve();
    mount(CLAUDE_SESSION);
    const history = await waitFor(() => screen.getByTestId("fresh-start-history"));
    assert.match(history.textContent, /^Fresh start at .+ · handoff$/);
    assert.ok(!history.textContent.includes("/private/"));
  } finally {
    recoveryStatus = { compactionLoops: null };
  }
});

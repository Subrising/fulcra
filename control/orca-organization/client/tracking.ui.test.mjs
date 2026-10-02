// J4 × J0-9 (C1 fix-up) with synthetic component adapters (not a Paseo/phone UI test): the Trackers tab keeps the last
// good copy when a read stalls, says how old it is from the payload's own observedAt, and never shows one host's copy
// on another host.
import { TrackingSurface } from "./tracking";
import { forgetAll } from "./last-good";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setHandler, calls } from "./ui-test-adapters.mjs";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
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
    statusWarning: "#c90",
  },
};
const PROJECT = "22222222-2222-4222-8222-000000000001";
afterEach(() => {
  cleanup();
  forgetAll();
});
const mount = (host) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    h(
      QueryClientProvider,
      { client },
      h(TrackingSurface, { theme, layout: { compact: false }, host }),
    ),
  );
};
const observedAt = new Date(Date.now() - 12 * 60000).toISOString();
const directory = {
  observedAt,
  available: true,
  partial: false,
  note: "",
  projects: [{ id: PROJECT, name: "Customer app", mapping: null, tasks: [], sessions: [] }],
};
const view = { version: 1, observedAt, partial: false, trackers: [], items: [] };
const healthy = (name) =>
  name === "organization.trackers.directory"
    ? directory
    : name === "organization.tracker-view"
      ? view
      : name === "organization.tracker-mappings"
        ? { version: 1, observedAt, partial: false, mappings: [], legacy: null }
        : { version: 1, observedAt, partial: false, hostApi: false, connectors: [], accounts: [] };
const slow = () => {
  throw Error("organization.trackers.directory did not finish within 20 s");
};

test("a stalled read keeps the last good copy for the same host, aged from its observation", async () => {
  setHandler(healthy);
  mount({ id: "host-a" });
  await screen.findByText("Trackers for Customer app");
  cleanup();
  setHandler(slow);
  mount({ id: "host-a" });
  await screen.findByText("Trackers for Customer app");
  assert(
    await screen.findByText(/^Last updated 12 min ago · Fulcra is slow to answer; retrying$/),
    "the age is the observation's, not the time it arrived",
  );
  assert.equal(
    screen.queryByText("The project list could not be loaded. Try again in a moment."),
    null,
    "no error over a good copy",
  );
});

test("another host never shows this host's copy", async () => {
  setHandler(healthy);
  mount({ id: "host-a" });
  await screen.findByText("Trackers for Customer app");
  cleanup();
  setHandler(slow);
  mount({ id: "host-b" });
  await screen.findByText("The project list could not be loaded. Try again in a moment.");
  assert.equal(screen.queryByText("Trackers for Customer app"), null);
});

// ---- REVIEW-J4 R-E-1 and R-E-9 ------------------------------------------------------------------------------
const MAPPING = "99999999-9999-4999-8999-000000000001",
  ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
  TASK = "33333333-3333-4333-8333-000000000001";
const jira = {
  id: "jira",
  label: "Jira",
  kinds: ["ticket"],
  selfHosted: false,
  auth: ["token"],
  keyPatterns: ["[A-Z][A-Z0-9]+-\\d+"],
  sync: { pollSeconds: 120, webhook: false },
  tokenHelp: {
    createUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    scopes: [],
    note: "Read only.",
  },
};
const account = {
  version: 1,
  id: ACCOUNT,
  connector: "jira",
  site: "acme.atlassian.net",
  displayName: "test-account",
  method: "token",
  scopes: [],
  state: "connected",
  expiresAt: null,
  lastCheckedAt: observedAt,
  createdAt: observedAt,
};
const item = {
  key: "issue:jira@acme.atlassian.net:10001:ACME-12",
  connector: "jira",
  kind: "ticket",
  ref: "ACME-12",
  title: "Sign-in fails",
  state: "open",
  url: "https://acme.atlassian.net/browse/ACME-12",
  updatedAt: observedAt,
  assignee: null,
  labels: [],
};
const removedLink = {
  id: "77777777-7777-4777-8777-000000000001",
  from: item.key,
  to: `task:${TASK}`,
  relation: "worked-by",
  provenance: "manual",
  confidence: "high",
  evidence: "Set by hand in the Trackers view.",
  state: "removed",
  revision: 2,
  createdAt: observedAt,
  at: observedAt,
  by: "operator",
};
function withTracking(extra = {}) {
  setHandler((name, input) => {
    if (name === "organization.trackers.directory")
      return { ...directory, projects: [{ ...directory.projects[0], tasks: [TASK] }] };
    if (name === "organization.tracker-view")
      return {
        ...view,
        trackers: [
          {
            mappingId: MAPPING,
            connector: "jira",
            label: "Jira",
            remoteName: "ACME",
            commandLine: false,
            status: "ok",
            retryAt: null,
            observedAt,
          },
        ],
        items: [{ item, stale: false, observedAt, links: [removedLink], trail: [] }],
      };
    if (name === "organization.tracker-mappings")
      return {
        version: 1,
        observedAt,
        partial: false,
        legacy: null,
        mappings: [
          {
            id: MAPPING,
            revision: 2,
            projectId: PROJECT,
            connector: "jira",
            accountId: ACCOUNT,
            remoteId: "10001",
            remoteName: "ACME",
            site: "acme.atlassian.net",
            state: "unmapped",
            note: "",
            at: observedAt,
          },
        ],
      };
    if (name === "organization.integrations")
      return {
        version: 1,
        observedAt,
        partial: false,
        hostApi: true,
        connectors: [jira],
        accounts: [account],
      };
    if (name === "organization.tracker-mappings.resolve")
      return {
        ok: true,
        message: null,
        remote: { remoteId: "10001", remoteName: "ACME", site: "acme.atlassian.net" },
      };
    if (name === "organization.tracker-mappings.map")
      return { ok: true, message: null, mapping: null };
    if (name === "organization.links.set")
      return { ok: true, message: null, link: { ...removedLink, state: "active", revision: 3 } };
    return extra[name]?.(input) ?? null;
  });
}

test("R-E-1 and R-E-9: no site is typed (the account's is shown and derived by the server); adding a removed tracker again continues its revision", async () => {
  withTracking();
  mount({ id: "host-a" });
  fireEvent.click(await screen.findByRole("button", { name: "Add a tracker to Customer app" }));
  assert(
    await screen.findByRole("button", { name: "test-account · acme.atlassian.net" }),
    "the account shows its site",
  );
  assert.equal(screen.queryByLabelText("Server address"), null, "there is no site box");
  fireEvent.change(screen.getByLabelText("Jira repository or project"), {
    target: { value: "ACME" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check it" }));
  assert(await screen.findByText("Track Jira ACME on acme.atlassian.net for Customer app?"));
  fireEvent.click(screen.getByRole("button", { name: "Yes, track ACME" }));
  await waitFor(() => assert(calls.some((c) => c.name === "organization.tracker-mappings.map")));
  const resolve = calls.find((c) => c.name === "organization.tracker-mappings.resolve"),
    map = calls.find((c) => c.name === "organization.tracker-mappings.map");
  assert.equal(resolve.input.site, null, "the caller never names a site");
  assert.equal(map.input.expectedRevision, 2, "the retained (removed) mapping row's revision");
});

test("R-E-9: marking a worker again after removing its link names the removed link's revision", async () => {
  withTracking();
  mount({ id: "host-a" });
  fireEvent.click(await screen.findByRole("button", { name: "Correct who worked on ACME-12" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Mark ACME-12 as worked on by this project's workstream ${TASK.slice(0, 8)}`,
    }),
  );
  await waitFor(() => assert(calls.some((c) => c.name === "organization.links.set")));
  assert.equal(calls.find((c) => c.name === "organization.links.set").input.expectedRevision, 2);
});

// L36: tracker items are fetched only by the refresh (a write); opening a project runs it and shows its result at once.
test("L36: opening a project refreshes its trackers and shows the fresh items", async () => {
  const fresh = {
    ...view,
    trackers: [
      {
        mappingId: MAPPING,
        connector: "jira",
        label: "Jira",
        remoteName: "ACME",
        commandLine: false,
        status: "ok",
        retryAt: null,
        observedAt,
      },
    ],
    items: [{ item, stale: false, observedAt, links: [], trail: [] }],
  };
  // As the real store: the read returns what the refresh stored, and nothing before it ran.
  let refreshed = false;
  setHandler((name) =>
    name === "organization.tracker-refresh"
      ? ((refreshed = true), fresh)
      : name === "organization.tracker-view"
        ? refreshed
          ? fresh
          : view
        : healthy(name),
  );
  mount({ id: "host-a" });
  assert(await screen.findByText(/Sign-in fails/));
  assert(
    calls.some((c) => c.name === "organization.tracker-refresh" && c.input?.projectId === PROJECT),
    "the refresh ran for the opened project",
  );
});

// ---- U7 W4: this Mac's GitHub sign-in is the command-line login, offered once --------------------------------
test("W4: this Mac's GitHub sign-in is not offered as a separate account; the command-line login reads the tracker", async () => {
  const github = {
    id: "github",
    label: "GitHub",
    kinds: ["issue", "pr"],
    selfHosted: false,
    auth: ["token", "cli"],
    keyPatterns: ["#[1-9][0-9]{0,9}"],
    sync: { pollSeconds: 60, webhook: false },
    tokenHelp: { createUrl: "https://github.com/settings/tokens", scopes: [], note: "Read only." },
  };
  const signIn = {
    version: 1,
    id: "aaaaaaaa-aaaa-5aaa-8aaa-000000000009",
    connector: "github",
    site: null,
    displayName: "dzgray",
    method: "cli",
    scopes: [],
    state: "connected",
    expiresAt: null,
    lastCheckedAt: observedAt,
    createdAt: observedAt,
  };
  setHandler((name) => {
    if (name === "organization.trackers.directory") return directory;
    if (name === "organization.tracker-view") return view;
    if (name === "organization.tracker-mappings")
      return { version: 1, observedAt, partial: false, mappings: [], legacy: null };
    if (name === "organization.integrations")
      return {
        version: 1,
        observedAt,
        partial: false,
        hostApi: true,
        connectors: [github],
        accounts: [signIn],
      };
    if (name === "organization.tracker-mappings.resolve")
      return {
        ok: true,
        message: null,
        remote: { remoteId: "1", remoteName: "fulcra/app", site: null },
      };
    return null;
  });
  mount({ id: "host-a" });
  fireEvent.click(await screen.findByRole("button", { name: "Add a tracker to Customer app" }));
  assert(
    await screen.findByRole("button", {
      name: "Command-line login on this computer (broad access)",
    }),
  );
  assert.equal(
    !!screen.queryByRole("button", { name: "dzgray" }),
    false,
    "the sign-in is not a separate choice",
  );
  fireEvent.change(screen.getByLabelText("GitHub repository or project"), {
    target: { value: "fulcra/app" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Check it" }));
  const githubResolve = () =>
    calls.find(
      (c) => c.name === "organization.tracker-mappings.resolve" && c.input.connector === "github",
    );
  await waitFor(() => assert(githubResolve()));
  assert.equal(
    githubResolve().input.accountId,
    null,
    "read through gh itself, never the listed sign-in",
  );
});

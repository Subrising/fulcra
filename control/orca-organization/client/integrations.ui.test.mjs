// Fulcra J4b Settings › Integrations behaviour with synthetic component adapters (not a Paseo/phone UI test): the
// Jira and Bitbucket rows ask for exactly what the host's token sign-in needs, the pasted token goes only to the
// host and is cleared, token-help links open only provider pages, and a `revoked` account offers only a retry.
import { IntegrationsScreen, tokenFields } from "./integrations";
import { isTrackerUrl, openHelpUrl, refSite } from "./tracker-link";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { calls, setHandler, setPaseo, openedUrls } from "./ui-test-adapters.mjs";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup } = await import("@testing-library/react");
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
const TOKEN = "CANARY-pasted-" + "x".repeat(20);
const clients = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    h(
      QueryClientProvider,
      { client },
      h(IntegrationsScreen, { theme, layout: { compact: false } }),
    ),
  );
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  openedUrls.length = 0;
  setPaseo(null);
});
const connector = (id, label, selfHosted, kinds, createUrl, scopes) => ({
  id,
  label,
  kinds,
  selfHosted,
  auth: ["token"],
  keyPatterns: ["[A-Z][A-Z0-9]+-\\d+"],
  sync: { pollSeconds: 120, webhook: false },
  tokenHelp: { createUrl, scopes, note: "Fulcra never writes to it." },
});
const CONNECTORS = [
  connector(
    "jira",
    "Jira",
    false,
    ["ticket"],
    "https://id.atlassian.com/manage-profile/security/api-tokens",
    ["read:jira-work", "read:jira-user"],
  ),
  connector(
    "jira-dc",
    "Jira Data Center",
    true,
    ["ticket"],
    "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
    ["Browse projects (for the projects you track)"],
  ),
  connector(
    "bitbucket",
    "Bitbucket",
    false,
    ["issue", "pr"],
    "https://id.atlassian.com/manage-profile/security/api-tokens",
    ["read:repository:bitbucket"],
  ),
  connector(
    "bitbucket-dc",
    "Bitbucket Data Center",
    true,
    ["pr"],
    "https://confluence.atlassian.com/bitbucketserver/http-access-tokens-939515499.html",
    [],
  ),
];
const account = (n, connectorId, state, site = null) => ({
  version: 1,
  id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  connector: connectorId,
  site,
  displayName: `test-account-${n}`,
  method: "token",
  scopes: [],
  state,
  expiresAt: null,
  lastCheckedAt: "2026-09-24T12:00:00.000Z",
  createdAt: "2026-09-20T12:00:00.000Z",
});
function host() {
  const log = [];
  const credentials = {
    begin: async (input) => {
      log.push(["begin", input]);
      return { flowId: "flow-1" };
    },
    complete: async (input) => {
      log.push(["complete", input]);
      return { status: "connected", account: { displayName: "test-account-new" } };
    },
    reconnect: async (input) => {
      log.push(["reconnect", input]);
      return { flowId: "flow-2" };
    },
    remove: async (id) => {
      log.push(["remove", id]);
      return { removed: true };
    },
  };
  setPaseo({ credentials });
  return log;
}
const serve = (accounts) =>
  setHandler((name) =>
    name === "organization.integrations"
      ? {
          version: 1,
          observedAt: "2026-09-24T12:00:00.000Z",
          partial: false,
          hostApi: true,
          connectors: CONNECTORS,
          accounts,
        }
      : null,
  );
const type = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("I1: Jira Cloud asks for the site, the Atlassian email and the token; the token goes only to the host and is cleared", async () => {
  const log = host();
  serve([]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Connect Jira" }));
  const connect = () => screen.getByRole("button", { name: "Connect Jira with this token" });
  assert.equal(connect().disabled, true);
  type("Jira site", "Acme.atlassian.net");
  type("Jira token", TOKEN);
  assert.equal(connect().disabled, true, "the email is required for Jira Cloud");
  type("The email address of your Atlassian account", "test@example.invalid");
  assert.equal(connect().disabled, false);
  assert(screen.getByText(/read:jira-work/));
  fireEvent.click(connect());
  await screen.findByText("test-account-new is connected.");
  assert.deepEqual(log, [
    ["begin", { connector: "jira", method: "token", site: "acme.atlassian.net" }],
    [
      "complete",
      { flowId: "flow-1", input: { kind: "token", token: TOKEN, email: "test@example.invalid" } },
    ],
  ]);
  assert.equal(
    JSON.stringify(calls).includes(TOKEN),
    false,
    "no plugin RPC ever carries the token",
  );
  assert.equal(document.body.innerHTML.includes(TOKEN), false, "the form was cleared");
});

test("I2: Data Center rows ask for the server; Bitbucket Data Center takes an optional username", async () => {
  const log = host();
  serve([]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Connect Bitbucket Data Center" }));
  type("Bitbucket Data Center server address", "git.example.com");
  type("Bitbucket Data Center token", TOKEN);
  assert(screen.getByLabelText("Your Bitbucket username (only for a personal token)"));
  assert.equal(
    screen.queryByText("Give it only these permissions:"),
    null,
    "no scope list when the token has none",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Connect Bitbucket Data Center with this token" }),
  );
  await waitFor(() => assert.equal(log.length, 2));
  assert.deepEqual(
    log[1][1].input,
    { kind: "token", token: TOKEN },
    "no username given, none sent",
  );
  assert.deepEqual(log[0][1], {
    connector: "bitbucket-dc",
    method: "token",
    site: "git.example.com",
  });
  // Jira Data Center: the server and the token, and no email.
  assert.deepEqual(tokenFields({ id: "jira-dc", selfHosted: true }), {
    site: "required",
    sitePlaceholder: "jira.example.com",
  });
  assert.deepEqual(tokenFields({ id: "bitbucket", selfHosted: false }).email, "required");
  assert.deepEqual(tokenFields({ id: "github", selfHosted: false }), {});
});

test('I3: a revoked account says "Couldn\'t remove; retry" and offers only Retry disconnect', async () => {
  const log = host();
  serve([
    account(1, "bitbucket", "revoked"),
    account(2, "jira", "connected", "acme.atlassian.net"),
  ]);
  mount();
  await screen.findByText("⚠ Couldn't remove; retry");
  assert.equal(screen.queryByRole("button", { name: "Reconnect test-account-1" }), null);
  assert.equal(screen.queryByRole("button", { name: "Disconnect test-account-1" }), null);
  assert(
    screen.getByRole("button", { name: "Reconnect test-account-2" }),
    "a connected account keeps Reconnect",
  );
  assert(screen.getByText("acme.atlassian.net"), "the site is shown on the row");
  fireEvent.click(screen.getByRole("button", { name: "Retry disconnecting test-account-1" }));
  await waitFor(() => assert.deepEqual(log, [["remove", "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"]]));
});

test('I4: "Create one" opens only provider help pages; Data Center items open only on their own site', async () => {
  host();
  serve([]);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Connect Jira Data Center" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create a Jira Data Center token (opens Jira Data Center)",
    }),
  );
  assert.deepEqual(openedUrls, [
    "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html",
  ]);
  for (const bad of [
    "https://evil.example.com/tokens",
    "http://id.atlassian.com/x",
    "https://id.atlassian.com.evil.example.com/x",
  ])
    assert.equal(
      openHelpUrl(bad, async () => {}),
      false,
      bad,
    );
  assert.equal(refSite("issue:jira-dc@jira.example.com:10001:ACME-12"), "jira.example.com");
  assert.equal(refSite("pr:bitbucket-dc@git.example.com:ACME/web#9"), "git.example.com");
  assert.equal(refSite("pr:github:acme/app#1"), null);
  assert.equal(isTrackerUrl("https://jira.example.com/browse/ACME-12", "jira.example.com"), true);
  assert.equal(
    isTrackerUrl("https://jira.example.com.evil.example/browse/ACME-12", "jira.example.com"),
    false,
  );
  assert.equal(
    isTrackerUrl("https://jira.example.com/browse/ACME-12"),
    false,
    "no site, no self-hosted URL",
  );
});

// ---- U7 W4: this Mac's GitHub sign-in ------------------------------------------------------------------------
test("W4: this Mac's GitHub sign-in is shown as such, with nothing to reconnect or disconnect", async () => {
  const github = {
    ...connector("github", "GitHub", false, ["issue", "pr"], "https://github.com/settings/tokens", [
      "repo",
    ]),
    auth: ["token", "cli"],
  };
  host();
  setHandler((name) =>
    name === "organization.integrations"
      ? {
          version: 1,
          observedAt: "2026-09-24T12:00:00.000Z",
          partial: false,
          hostApi: true,
          connectors: [github],
          accounts: [
            { ...account(3, "github", "connected"), displayName: "dzgray", method: "cli" },
          ],
        }
      : null,
  );
  mount();
  await screen.findByText("dzgray");
  assert(
    screen.getByText(
      "From this Mac's GitHub sign-in. To change it, run gh auth login, or connect another GitHub account here.",
    ),
  );
  assert.equal(!!screen.queryByRole("button", { name: "Reconnect dzgray" }), false, "no Reconnect");
  assert.equal(
    !!screen.queryByRole("button", { name: "Disconnect dzgray" }),
    false,
    "no Disconnect",
  );
  assert(
    screen.getByRole("button", { name: "Connect GitHub" }),
    "another account can still be connected, and it wins",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { conversationLink, conversationMessage } from "./conversation-link";
const agent = "22222222-2222-4222-8222-222222222222";
const mini = "srv_fixture_desk",
  book = "srv_fixture_workshop";
test("authenticated configured binding replaces defaults and absent binding never falls back", () => {
  const target = "srv_private_book_123";
  const f = fixture();
  assert.equal(
    conversationLink("Workshop", agent, mini, f.navigation, target).open!(),
    "requested",
  );
  assert.deepEqual(f.calls, [{ serverId: target, agentId: agent }]);
  for (const missing of [null, "", "https://untrusted.example", "srv_bad"]) {
    const checked = conversationLink("Workshop", agent, book, f.navigation, missing);
    assert.equal(checked.open, undefined);
    assert.match(checked.message, /not configured/);
  }
  assert.equal(f.calls.length, 1);
  const { openAgentOnHost: _, ...legacy } = f.navigation;
  assert.equal(conversationLink("Workshop", agent, book, legacy, target).open, undefined);
  assert.equal(conversationLink("Workshop", agent, target, legacy, target).open!(), "requested");
});
function fixture(result: unknown = "requested") {
  const calls: unknown[] = [];
  return {
    calls,
    navigation: {
      openAgent: (input: unknown) => {
        calls.push({ legacy: input });
      },
      openWorkspace: () => {},
      openAgentOnHost: (input: unknown) => {
        calls.push(input);
        return result;
      },
    },
  };
}
test("explicit navigation selects the reported pinned target, never the rendering host", () => {
  for (const [host, serverId] of [
    ["Desk", mini],
    ["Workshop", book],
  ]) {
    const f = fixture();
    assert.equal(
      conversationLink(host, agent, "unrelated-server", f.navigation, serverId).open!(),
      "requested",
    );
    assert.deepEqual(f.calls, [{ serverId, agentId: agent }]);
  }
});
test("legacy navigation works only on the matching serverId namespace", () => {
  for (const [host, serverId] of [
    ["Desk", mini],
    ["Workshop", book],
  ]) {
    const f = fixture(),
      { openAgentOnHost: _, ...legacy } = f.navigation;
    assert.equal(conversationLink(host, agent, serverId, legacy, serverId).open!(), "requested");
    for (const wrong of [host, "unknown", undefined, serverId === mini ? book : mini]) {
      assert.equal(conversationLink(host, agent, wrong, legacy, serverId).open, undefined);
    }
    assert.deepEqual(f.calls, [{ legacy: { agentId: agent } }]);
  }
});
test("unknown identities and absent capabilities have no action", () => {
  for (const [host, id] of [
    ["unknown", agent],
    ["Workshop", null],
    ["Desk", "invalid"],
  ]) {
    const f = fixture();
    assert.equal(conversationLink(host!, id, mini, f.navigation, mini).open, undefined);
    assert.deepEqual(f.calls, []);
  }
  assert.match(
    conversationLink("Workshop", agent, mini, undefined, book).message,
    /latest Fulcra client/,
  );
});
test("unavailable target requires explicit reinvocation and never falls back", () => {
  const f = fixture("host-unavailable"),
    link = conversationLink("Workshop", agent, mini, f.navigation, book);
  assert.equal(link.open!(), "host-unavailable");
  assert.deepEqual(f.calls, [{ serverId: book, agentId: agent }]);
  f.navigation.openAgentOnHost = (input) => {
    f.calls.push(input);
    return "requested";
  };
  assert.equal(f.calls.length, 1);
  assert.equal(link.open!(), "requested");
  assert.equal(f.calls.length, 2);
  assert.match(conversationMessage("host-unavailable", "Workshop"), /then try again/);
});
test("exceptions and unknown replies are failures, not completed navigation", () => {
  for (const value of [undefined, null, "loaded", true]) {
    const f = fixture(value);
    if (value === undefined) f.navigation.openAgentOnHost = () => undefined;
    assert.equal(conversationLink("Workshop", agent, mini, f.navigation, book).open!(), "failed");
  }
  const f = fixture();
  f.navigation.openAgentOnHost = () => {
    throw Error("PRIVATE");
  };
  assert.equal(conversationLink("Workshop", agent, mini, f.navigation, book).open!(), "failed");
  assert(!conversationMessage("failed", "Workshop").includes("PRIVATE"));
  assert.equal(conversationMessage("requested", "Workshop"), "Opening Workshop conversation…");
});

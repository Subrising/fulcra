import test from "node:test";
import assert from "node:assert/strict";
import { planChange, summarise, readTemplate, typeLabel } from "./deploy-plan.mjs";

const T = "@2023-10-01-preview";
const app = {
  import: "radius",
  type: `Applications.Core/applications${T}`,
  properties: { name: "shop", properties: { environment: "[parameters('environment')]" } },
};
const web = (image, extra = {}) => ({
  import: "radius",
  type: `Applications.Core/containers${T}`,
  properties: {
    name: "web",
    properties: {
      application: "[reference('app').id]",
      container: { image, ports: { web: { containerPort: 3000 } }, ...extra },
      ...(extra.connections ? { connections: extra.connections } : {}),
    },
  },
});
const cache = {
  import: "radius",
  type: `Applications.Datastores/redisCaches${T}`,
  properties: { name: "cache", properties: { application: "[reference('app').id]" } },
};
const pg = {
  import: "radius",
  type: "Radius.Data/postgreSqlDatabases@2025-08-01-preview",
  properties: { name: "orders", properties: {} },
};
const tpl = (resources) => ({
  metadata: { _generator: { templateHash: String(Math.random()) } },
  resources,
});

test("first deploy reads as one plain sentence", () => {
  const plan = planChange({ previous: null, next: tpl({ app, web: web("demo:1.0") }) });
  assert.equal(plan.first, true);
  assert.equal(plan.summary, "First deploy of shop: adds a container (web).");
  assert.equal(plan.destructive, false);
  assert.deepEqual(
    plan.map.parts.map((p) => [p.name, p.state]),
    [["web", "new"]],
  );
});

test("adding a database and updating a container, with the blast radius", () => {
  const before = tpl({ app, web: web("demo:1.0") });
  const webWithDb = web("demo:1.1");
  webWithDb.properties.properties.connections = { db: { source: "[reference('pg').id]" } };
  const after = tpl({ app, web: webWithDb, pg });
  const plan = planChange({ previous: before, next: after });
  assert.equal(plan.summary, "Adds a Postgres database (orders) and updates the web container.");
  const update = plan.changes.find((c) => c.kind === "update");
  assert.deepEqual(update.details, ["Image demo:1.0 → demo:1.1", "Now connects to db"]);
  assert.ok(plan.risks.includes("The web container restarts while it updates."));
  assert.deepEqual(plan.map.links, [
    {
      from: "applications.core/containers/web",
      to: "radius.data/postgresqldatabases/orders",
      state: "new",
    },
  ]);
});

test("removing a data store is destructive and says the data goes", () => {
  const w = web("demo:1.0");
  w.properties.properties.connections = { redis: { source: "[reference('cache').id]" } };
  const before = tpl({ app, web: w, cache });
  const after = tpl({ app, web: web("demo:1.0") });
  const plan = planChange({ previous: before, next: after });
  assert.equal(plan.destructive, true);
  assert.equal(plan.deletesData, true);
  assert.match(plan.summary, /removes the Redis cache \(cache\)/);
  assert.ok(plan.risks.some((r) => /cannot be undone/.test(r)));
  assert.equal(plan.map.parts.find((p) => p.name === "cache").state, "removed");
});

test("an unchanged redeploy says nothing changes, whatever the compiler metadata", () => {
  const plan = planChange({
    previous: tpl({ app, web: web("demo:1.0") }),
    next: tpl({ app, web: web("demo:1.0") }),
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.summary, "Nothing changes. What is running already matches this version.");
});

test("setting values are never shown, only their names", () => {
  const plan = planChange({
    previous: tpl({ app, web: web("demo:1.0", { env: { TOKEN: { value: "old-secret" } } }) }),
    next: tpl({ app, web: web("demo:1.0", { env: { TOKEN: { value: "new-secret" } } }) }),
  });
  assert.deepEqual(plan.changes[0].details, ["Settings changed: TOKEN"]);
  assert.doesNotMatch(JSON.stringify(plan), /secret"/);
});

test("resources not deployed from Fulcra are reported and left alone", () => {
  const plan = planChange({
    previous: tpl({ app, web: web("demo:1.0") }),
    next: tpl({ app, web: web("demo:1.0") }),
    live: [
      { type: "Applications.Core/containers", name: "web" },
      { type: "Applications.Core/containers", name: "hand-made" },
    ],
  });
  assert.ok(plan.notes.some((n) => /hand-made/.test(n) && /leaves it alone/.test(n)));
  assert.equal(plan.changes.length, 0);
});

test("unpinned images and cloud cost are flagged in plain words", () => {
  const plan = planChange({
    previous: null,
    next: tpl({ app, web: web("demo:latest"), cache }),
    local: false,
  });
  assert.ok(plan.risks.some((r) => /without a fixed version/.test(r)));
  assert.ok(plan.notes.some((n) => /billed cloud service/.test(n)));
});

test("grouping and labels", () => {
  assert.equal(typeLabel("Applications.Datastores/redisCaches@x"), "Redis cache");
  const c = (name, kind) => ({
    key: name,
    type: "applications.core/containers",
    name,
    label: "container",
    kind,
  });
  assert.equal(
    summarise([c("a", "add"), c("b", "add"), c("w", "remove")]),
    "Adds 2 containers (a, b) and removes the w container.",
  );
  assert.equal(
    readTemplate({ resources: { x: { type: "A/b@1", properties: { name: "n" } } } }).resources[0]
      .key,
    "a/b/n",
  );
});

test("three kinds of change read as one sentence, and gateway addresses are named", () => {
  const gw = (host) => ({
    type: `Applications.Core/gateways${T}`,
    properties: {
      name: "gateway",
      properties: {
        hostname: host ? { fullyQualifiedHostname: host } : undefined,
        routes: [{ path: "/", destination: "http://web:80" }],
      },
    },
  });
  const plan = planChange({
    previous: tpl({ app, web: web("demo:1.0"), gateway: gw(null), cache }),
    next: tpl({ app, web: web("demo:1.1"), gateway: gw("shop.localhost"), pg }),
  });
  assert.equal(
    plan.summary,
    "Adds a Postgres database (orders), updates the web container and the public address (gateway) and removes the Redis cache (cache).",
  );
  assert.deepEqual(plan.changes.find((c) => c.name === "gateway").details, [
    "Web address default → shop.localhost",
  ]);
  assert.deepEqual(
    plan.map.links.map((l) => [l.from.split("/").pop(), l.to.split("/").pop()]),
    [["gateway", "web"]],
  );
});

test("a removed cache's risk names it the same way as the summary", () => {
  const plan = planChange({
    previous: tpl({ app, web: web("demo:1.0"), cache }),
    next: tpl({ app, web: web("demo:1.0") }),
  });
  assert.deepEqual(plan.risks, [
    "Deletes the Redis cache (cache) and everything stored in it. This cannot be undone.",
  ]);
});

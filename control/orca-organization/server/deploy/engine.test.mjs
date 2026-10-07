// The deploy engine end to end against a real git repository, with rad, bicep, k3d and docker replaced by a fake
// cluster that remembers what was deployed. The real tools are exercised by the k3d check in docs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createDeployEngine,
  packKubeconfig,
  unpackKubeconfig,
  kubeconfigContexts,
  reach,
} from "./engine.mjs";
import { runTool } from "./run.mjs";
import { main as planCli } from "./cli.mjs";

const T = "@2023-10-01-preview";
const resource = (type, name, body = {}) => ({
  import: "radius",
  type: `${type}${T}`,
  properties: { name, properties: body },
});
const app = resource("Applications.Core/applications", "shop");
const web = (image, connections) =>
  resource("Applications.Core/containers", "web", {
    application: "[reference('app').id]",
    container: { image, ports: { web: { containerPort: 3000 } } },
    ...(connections ? { connections } : {}),
  });
const cache = resource("Applications.Datastores/redisCaches", "cache", {
  application: "[reference('app').id]",
});

// The fake bicep compiler reads the template from a comment in the committed file.
const bicepSource = (resources) =>
  `extension radius\n// TEMPLATE ${JSON.stringify({ resources })}\n`;

function fakeCluster() {
  const state = { live: new Map(), calls: [], kubeconfigs: [] };
  const run = async (file, args, options = {}) => {
    const tool = path.basename(file);
    if (tool === "git" || tool === "tar") return runTool(file, args, options);
    state.calls.push([tool, ...args]);
    if (options.env?.KUBECONFIG && options.env.KUBECONFIG !== "/dev/null")
      state.kubeconfigs.push(options.env.KUBECONFIG);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (tool === "docker") return ok("27.0.0");
    if (tool === "k3d") {
      if (args[0] === "kubeconfig") return ok("apiVersion: v1\nkind: Config\n");
      if (args[0] === "cluster" && args[1] === "list")
        return { code: 1, stdout: "", stderr: "not found" };
      return ok();
    }
    if (tool === "bicep") {
      const text = fs.readFileSync(args[1], "utf8");
      return ok(/TEMPLATE (.*)/.exec(text)[1]);
    }
    if (tool === "rad") {
      const [a, b] = args;
      if (a === "deploy") {
        const template = JSON.parse(fs.readFileSync(args[1], "utf8"));
        options.onLine?.("Deploying template...");
        for (const r of Object.values(template.resources))
          state.live.set(r.properties.name, {
            type: r.type.split("@")[0],
            name: r.properties.name,
          });
        return ok();
      }
      if (a === "resource" && b === "list") return ok(JSON.stringify([...state.live.values()]));
      if (a === "resource" && b === "delete") {
        state.live.delete(args[3]);
        return ok();
      }
      if (a === "application" && b === "status") return ok(JSON.stringify({ Gateways: [] }));
      return ok();
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { state, run };
}

const fakeTools = (root) => ({
  bin: path.join(root, "bin"),
  path: (name) => `/fake/${name}`,
  bicep: "/fake/bicep",
  env: (kubeconfig) => ({
    PATH: process.env.PATH,
    HOME: os.homedir(),
    KUBECONFIG: kubeconfig ?? "/dev/null",
  }),
  check: async () => ({ rad: true, k3d: true, bicep: true, docker: true }),
  install: async () => {},
  installBicep: async () => {},
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-repo-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "Test");
  const commit = (resources, message) => {
    fs.writeFileSync(path.join(dir, "app.bicep"), bicepSource(resources));
    g("add", "app.bicep");
    g("commit", "-q", "-m", message);
    return g("rev-parse", "HEAD");
  };
  return { dir, commit, g };
}

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-state-"));
  const cluster = fakeCluster();
  const saved = new Map();
  const secrets = {
    read: async (n) => saved.get(n) ?? null,
    save: async (n, v) => void saved.set(n, v),
    remove: async (n) => void saved.delete(n),
  };
  const engine = createDeployEngine({ root, run: cluster.run, tools: fakeTools(root), secrets });
  const { environmentId } = await engine.connectLocal({ name: "Test" });
  await engine.idle();
  return { root, cluster, engine, environmentId, saved };
}

test("connect, plan, confirm, change, redeploy and roll back on a local cluster", async () => {
  const { root, cluster, engine, environmentId } = await setup();
  const { environments } = await engine.overview();
  assert.equal(environments[0].state, "ready");
  assert.ok(
    cluster.state.calls.some((c) => c[0] === "k3d" && c[1] === "cluster" && c[2] === "create"),
  );
  assert.ok(cluster.state.calls.some((c) => c.join(" ").includes("recipe register default")));

  const r = repo();
  r.commit({ app, web: web("demo:1.0") }, "first");
  const first = await engine.plan({
    environmentId,
    repo: r.dir,
    project: "Shop",
    ref: { kind: "branch", value: "main" },
    preparedBy: { kind: "person" },
  });
  assert.equal(first.change.summary, "First deploy of shop: adds a container (web).");
  await engine.confirm({ planId: first.id, digest: first.digest });
  await engine.idle();
  assert.deepEqual([...cluster.state.live.keys()].sort(), ["shop", "web"]);

  r.g("checkout", "-q", "-b", "add-cache");
  r.commit(
    { app, web: web("demo:1.1", { redis: { source: "[reference('cache').id]" } }), cache },
    "cache",
  );
  const second = await engine.plan({
    environmentId,
    repo: r.dir,
    project: "Shop",
    ref: { kind: "branch", value: "add-cache" },
    preparedBy: { kind: "person" },
  });
  assert.equal(second.change.summary, "Adds a Redis cache (cache) and updates the web container.");
  assert.equal(second.change.destructive, false);
  const { jobId } = await engine.confirm({ planId: second.id, digest: second.digest });
  await engine.idle();
  const job = await engine.job({ jobId });
  assert.equal(job.status, "succeeded");
  assert.deepEqual(
    job.steps.map((s) => s.state),
    ["done", "done", "skipped", "done"],
  );
  assert.ok(cluster.state.live.has("cache"));

  const view = await engine.overview();
  assert.equal(view.environments[0].current.ref.label, "add-cache");
  assert.equal(view.environments[0].canRollBack, true);

  const back = await engine.prepareRollback({ environmentId });
  assert.equal(back.change.destructive, true);
  assert.equal(back.confirmWord, "Test");
  assert.match(back.change.summary, /removes the Redis cache \(cache\)/);
  await assert.rejects(
    engine.confirm({ planId: back.id, digest: back.digest }),
    /Type Test to confirm/,
  );
  await assert.rejects(
    engine.confirm({ planId: back.id, digest: back.digest, typed: "test!" }),
    /Type Test/,
  );
  await engine.confirm({ planId: back.id, digest: back.digest, typed: "Test" });
  await engine.idle();
  assert.equal(cluster.state.live.has("cache"), false);
  const after = await engine.overview();
  assert.equal(after.environments[0].current.kind, "rollback");
  assert.equal(after.environments[0].current.ref.label, "main");

  // Credentials were only ever in a private scratch file, and every one is gone.
  assert.ok(cluster.state.kubeconfigs.length > 0);
  assert.ok(cluster.state.kubeconfigs.every((f) => f.startsWith(root) && !fs.existsSync(f)));
});

test("a plan goes stale when something else deploys first, and a changed fingerprint is refused", async () => {
  const { engine, environmentId } = await setup();
  const r = repo();
  r.commit({ app, web: web("demo:1.0") }, "first");
  const a = await engine.plan({
    environmentId,
    repo: r.dir,
    project: "Shop",
    ref: { kind: "branch", value: "main" },
    preparedBy: { kind: "person" },
  });
  const b = await engine.plan({
    environmentId,
    repo: r.dir,
    project: "Shop",
    ref: { kind: "branch", value: "main" },
    preparedBy: { kind: "session", sessionId: "s1", label: "Release helper" },
  });
  await assert.rejects(
    engine.confirm({ planId: b.id, digest: "0".repeat(64) }),
    /not the plan that was previewed/,
  );
  await engine.confirm({ planId: b.id, digest: b.digest });
  await engine.idle();
  await assert.rejects(
    engine.confirm({ planId: a.id, digest: a.digest }),
    /Something else was deployed here/,
  );
  assert.equal((await engine.planView({ planId: a.id })).status, "stale");
  await assert.rejects(engine.confirm({ planId: b.id, digest: b.digest }), /already deployed/);
});

test("a session's plan is listed as waiting for a person and deploys nothing on its own", async () => {
  const { engine, environmentId, cluster } = await setup();
  const r = repo();
  r.commit({ app, web: web("demo:2.0") }, "first");
  const p = await engine.plan({
    environmentId,
    repo: r.dir,
    project: "Shop",
    ref: { kind: "commit", value: "HEAD" },
    preparedBy: { kind: "session", sessionId: "s1", label: "Release helper" },
  });
  const { plans } = await engine.overview();
  assert.equal(plans[0].id, p.id);
  assert.equal(plans[0].status, "ready");
  assert.equal(plans[0].preparedBy.label, "Release helper");
  assert.equal("template" in plans[0], false);
  assert.equal(
    cluster.state.calls.some((c) => c[0] === "rad" && c[1] === "deploy"),
    false,
  );
});

test("a commit without an app definition, and a bad ref, are explained", async () => {
  const { engine, environmentId } = await setup();
  const r = repo();
  fs.writeFileSync(path.join(r.dir, "README.md"), "hi");
  r.g("add", "README.md");
  r.g("commit", "-q", "-m", "readme");
  await assert.rejects(
    engine.plan({
      environmentId,
      repo: r.dir,
      project: "Shop",
      ref: { kind: "branch", value: "main" },
      preparedBy: { kind: "person" },
    }),
    /no Radius app definition/,
  );
  await assert.rejects(
    engine.plan({
      environmentId,
      repo: r.dir,
      project: "Shop",
      ref: { kind: "branch", value: "--output=x" },
      preparedBy: { kind: "person" },
    }),
    /Choose a branch or commit/,
  );
});

test("a connected cluster's sign-in goes to the Keychain, packed, and leaves with it", async () => {
  const { engine, saved } = await setup();
  const kubeconfig =
    "apiVersion: v1\ncontexts:\n- context:\n    cluster: prod\n  name: prod-admin\ncurrent-context: prod-admin\n";
  assert.deepEqual(kubeconfigContexts(kubeconfig), {
    names: ["prod-admin"],
    current: "prod-admin",
  });
  const { environmentId } = await engine.connectCluster({
    name: "Prod",
    kubeconfig,
    context: "prod-admin",
  });
  await engine.idle();
  const stored = saved.get(`deploy.${environmentId}.kubeconfig`);
  assert.equal(unpackKubeconfig(stored), kubeconfig);
  assert.equal(stored, packKubeconfig(kubeconfig));
  assert.ok(!/^[\s\S]*\n/.test(stored), "one line");
  await engine.disconnect({ environmentId });
  assert.equal(saved.has(`deploy.${environmentId}.kubeconfig`), false);
});

test("the session command prepares a plan, says it waits for a person, and deploys nothing", async () => {
  const { root, cluster, engine } = await setup();
  const r = repo();
  r.commit({ app, web: web("demo:3.0") }, "first");
  const lines = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-home-"));
  fs.renameSync(root, path.join(home, "deploy"));
  const plan = await planCli(
    ["--environment", "test", "--project", r.dir, "--as", "Release helper"],
    { ORCA_HOME: home, PASEO_AGENT_ID: "agent-1" },
    (l) => lines.push(l),
    (stateDir) =>
      createDeployEngine({ root: stateDir, run: cluster.run, tools: fakeTools(stateDir) }),
  );
  assert.equal(plan.preparedBy.kind, "session");
  assert.equal(plan.preparedBy.sessionId, "agent-1");
  assert.equal(plan.ref.label, "main");
  assert.match(lines[0], /^Prepared a plan for Test: First deploy of shop/);
  assert.match(lines.at(-1), /never deploys/);
  assert.equal(
    cluster.state.calls.some((c) => c[0] === "rad" && c[1] === "deploy"),
    false,
  );
  void engine;
});

test("a local app opens from this Mac only under a .localhost name; otherwise the card says why", () => {
  const local = { kind: "local", port: 8081 };
  const gw = (host) => ({
    resources: {
      g: {
        type: "Applications.Core/gateways@x",
        properties: {
          name: "g",
          properties: host ? { hostname: { fullyQualifiedHostname: host } } : {},
        },
      },
    },
  });
  assert.deepEqual(reach(local, gw("shop.localhost"), "http://shop.localhost"), {
    endpoint: "http://shop.localhost:8081",
    note: null,
  });
  assert.deepEqual(reach(local, gw("shop.localhost"), "unknown"), {
    endpoint: "http://shop.localhost:8081",
    note: null,
  });
  const internal = reach(local, gw(null), "http://gateway.shop.172.21.0.3.nip.io");
  assert.equal(internal.endpoint, null);
  assert.match(internal.note, /gateway\.shop\.172\.21\.0\.3\.nip\.io.*ending in \.localhost/);
  assert.deepEqual(reach({ kind: "cluster" }, gw(null), "https://shop.example.com"), {
    endpoint: "https://shop.example.com",
    note: null,
  });
});

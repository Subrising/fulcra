// Live check for Deploy from Fulcra: answers the app's deploy RPCs with the real engine (real rad, k3d and git) over
// HTTP on 127.0.0.1, so verify-deploy-live.mjs can drive the real UI against a real local cluster.
//   ORCA_HOME=<state root> SHOP_REPO=<git repo> node bridge.mjs [port]
// The mapping mirrors server/deploy/rpc.ts; "sources" lists the one sample repo instead of Fulcra's workspaces.
import http from "node:http";
import path from "node:path";
import { createDeployEngine } from "../../server/deploy/engine.mjs";
import { stateRoot } from "../../server/config.mjs";

const port = Number(process.argv[2] ?? 47901);
const repo = process.env.SHOP_REPO;
const engine = createDeployEngine({ root: path.join(stateRoot(process.env), "deploy") });
const SOURCE = { id: "shop-workspace", project: "Shop", branch: "main", pullRequests: [] };
const handlers = {
  "organization.deploy-overview": async () => ({
    available: true,
    message: null,
    ...(await engine.overview()),
  }),
  "organization.deploy-sources": async () => ({ sources: [SOURCE] }),
  "organization.deploy-connect-local": (i) => engine.connectLocal(i),
  "organization.deploy-connect-cluster": (i) => engine.connectCluster(i),
  "organization.deploy-disconnect": (i) => engine.disconnect(i),
  "organization.deploy-plan": (i) => {
    if (i.sourceId !== SOURCE.id)
      throw new Error("That project is not open in Fulcra on this host");
    return engine.plan({
      environmentId: i.environmentId,
      repo,
      project: "Shop",
      ref: i.ref,
      preparedBy: { kind: "person" },
    });
  },
  "organization.deploy-rollback-plan": (i) => engine.prepareRollback(i),
  "organization.deploy-plan-view": (i) => engine.planView(i),
  "organization.deploy-discard": (i) => engine.discard(i),
  "organization.deploy-confirm": (i) => engine.confirm(i),
  "organization.deploy-job": (i) => engine.job(i),
};
http
  .createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const { name, input } = JSON.parse(body || "{}");
    const started = Date.now();
    try {
      const handler = handlers[name];
      if (!handler) throw new Error(`No live handler for ${name}`);
      const output = await handler(input ?? {});
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, output }));
      console.log(`${name} ok ${Date.now() - started}ms`);
    } catch (error) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      console.log(`${name} refused: ${error instanceof Error ? error.message : error}`);
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`deploy bridge on 127.0.0.1:${port}`));

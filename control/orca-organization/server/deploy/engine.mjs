// Deploy from Fulcra. Connect an environment once, plan a branch, pull request or commit against it, show what will
// change, and deploy only after a person confirms that exact plan. Radius does the deploying; this file decides when.
//
// Rules this file keeps:
//   - Nothing touches an environment without confirm(), and confirm() needs the plan's fingerprint as previewed. If
//     anything was deployed since, or the environment no longer matches the preview, the plan goes stale instead.
//   - A plan that deletes anything also needs the environment's name typed out.
//   - A plan deploys the compiled template it previewed, never a fresh compile of a moving branch.
//   - Sessions may prepare plans. Only the app's confirm deploys them (the plugin RPC; there is no agent route).
//   - Credentials: a local k3d cluster's come from k3d when needed; a connected cluster's live in the Keychain. Either
//     is written to a private file only while one command runs, then removed.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import {
  planChange,
  canonicalJson,
  confirmWord,
  kubeconfigContexts,
} from "../../shared/cc/deploy-plan.mjs";
export { kubeconfigContexts };
import { createStore } from "./store.mjs";
import { createTools, RADIUS_VERSION } from "./tools.mjs";
import { runTool } from "./run.mjs";

const GROUP = "fulcra";
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const BICEP_CANDIDATES = ["app.bicep", "deploy/app.bicep", "infra/app.bicep", "radius/app.bicep"];
const DEFAULT_BICEPCONFIG = {
  experimentalFeaturesEnabled: { extensibility: true },
  extensions: { radius: "br:biceptypes.azurecr.io/radius:0.60" },
};
// Recipes Radius publishes for local development; a local environment registers these so a Redis cache or database
// in the app gets a real container to back it.
const LOCAL_RECIPES = [
  ["Applications.Datastores/redisCaches", "rediscaches"],
  ["Applications.Datastores/sqlDatabases", "sqldatabases"],
  ["Applications.Datastores/mongoDatabases", "mongodatabases"],
  ["Applications.Messaging/rabbitMQQueues", "rabbitmqqueues"],
];
const LOG_LINES = 400;

const plainError = (error) => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 600 ? text.slice(0, 599) + "…" : text;
};
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const withoutMetadata = (template) => {
  const { metadata: _metadata, ...rest } = template ?? {};
  return rest;
};

export function packKubeconfig(text) {
  return zlib.gzipSync(Buffer.from(text, "utf8")).toString("base64");
}
export function unpackKubeconfig(value) {
  return zlib.gunzipSync(Buffer.from(value, "base64")).toString("utf8");
}

/**
 * Where a person can open the app. Radius reports "unknown" on a local cluster, whose load balancer has no address,
 * so a local environment answers on localhost at the cluster's port, under the gateway's own host name.
 */
export function endpointFor(environment, template, reported) {
  return reach(environment, template, reported).endpoint;
}

/**
 * Where a person can open the app, or why they can't from here. On a local cluster the load balancer answers on
 * localhost at the cluster's port, routed by host name: a gateway named "*.localhost" opens from this Mac; Radius's
 * default "*.nip.io" name points at a Docker-internal address that does not.
 */
export function reach(environment, template, reported) {
  const local = environment.kind === "local" && environment.port;
  const named = Object.values(template?.resources ?? {}).find((r) =>
    /gateways@/i.test(r?.type ?? ""),
  )?.properties?.properties?.hostname?.fullyQualifiedHostname;
  let url = reported && reported !== "unknown" ? reported : null;
  if (!url && local && typeof named === "string" && /^[a-z0-9.-]+$/i.test(named))
    url = `http://${named}`;
  if (!url) return { endpoint: null, note: null };
  if (!local) return { endpoint: url, note: null };
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".localhost") && u.hostname !== "localhost")
      return {
        endpoint: null,
        note: `It answers inside the cluster at ${u.hostname}. To open it from this Mac, give the gateway a host name ending in .localhost.`,
      };
    if (!u.port) u.port = String(environment.port);
    return { endpoint: u.toString().replace(/\/$/, ""), note: null };
  } catch {
    return { endpoint: null, note: null };
  }
}

export function slug(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return /^[a-z]/.test(s) ? s : `env-${s}`.slice(0, 30);
}

/**
 * @param {{ root: string, secrets?: { read(name: string): Promise<string|null>, save?(name: string, value: string): Promise<void>, remove?(name: string): Promise<void> } | null, run?: typeof runTool, fetcher?: typeof fetch, now?: () => string, tools?: ReturnType<typeof createTools> }} options
 */
export function createDeployEngine({
  root,
  secrets = null,
  run = runTool,
  fetcher,
  now = () => new Date().toISOString(),
  tools: injectedTools,
}) {
  const store = createStore(root);
  const tools = injectedTools ?? createTools({ root, fetcher, run });
  const running = new Map(); // environmentId -> job id
  const active = new Set(); // job promises, so tests and shutdown can wait for them
  const must = (file, args, options) =>
    run(file, args, options).then((r) => {
      if (r.code !== 0) {
        const tail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
        throw new Error(tail || `${path.basename(file)} failed (exit ${r.code})`);
      }
      return r;
    });
  // Logs never show the person's home folder or the private scratch folder a command ran in.
  const scratchPath = new RegExp(
    `${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scratch/run-[^/\\s']+/`,
    "g",
  );
  const tidyLog = (line) =>
    line
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(scratchPath, "")
      .split(os.homedir())
      .join("~");
  const secretName = (environmentId) => `deploy.${environmentId}.kubeconfig`;
  const radConfig = (environment) => path.join(root, "rad", `${environment.id}.yaml`);

  async function writeRadConfig(environment) {
    const ws = `fulcra-${environment.radiusEnvironment}`;
    const scope = `/planes/radius/local/resourceGroups/${GROUP}`;
    const yaml = [
      "workspaces:",
      `  default: ${ws}`,
      "  items:",
      `    ${ws}:`,
      "      connection:",
      `        context: ${JSON.stringify(environment.context)}`,
      "        kind: kubernetes",
      `      environment: ${scope}/providers/Applications.Core/environments/${environment.radiusEnvironment}`,
      `      scope: ${scope}`,
      "",
    ].join("\n");
    await fsp.mkdir(path.dirname(radConfig(environment)), { recursive: true, mode: 0o700 });
    await fsp.writeFile(radConfig(environment), yaml, { mode: 0o600 });
  }

  async function kubeconfigText(environment) {
    if (environment.kind === "local") {
      const r = await must(tools.path("k3d"), ["kubeconfig", "get", environment.cluster], {
        env: tools.env(),
        timeoutMs: 30_000,
      });
      return r.stdout;
    }
    if (!secrets)
      throw new Error("This host cannot read the Keychain, so it cannot reach the cluster");
    const packed = await secrets.read(secretName(environment.id));
    if (!packed)
      throw new Error("The cluster's sign-in is missing from the Keychain. Connect it again.");
    return unpackKubeconfig(packed);
  }

  /**
   * Run `fn` with the environment's credentials in a private folder that is removed straight after. The folder is
   * also the tools' HOME: `rad install kubernetes` 0.60 reads ~/.kube/config for one step whatever KUBECONFIG says,
   * and this keeps it away from the person's own ~/.kube.
   */
  async function withAccess(environment, fn) {
    const dir = await store.scratch();
    try {
      const file = path.join(dir, ".kube", "config");
      await fsp.mkdir(path.dirname(file), { mode: 0o700 });
      await fsp.writeFile(file, await kubeconfigText(environment), { mode: 0o600 });
      return await fn({
        env: { ...tools.env(file), HOME: dir },
        config: radConfig(environment),
        dir,
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  // ---------- jobs ----------
  async function startJob(kind, environmentId, labels, work) {
    if (running.has(environmentId))
      throw new Error("Something is already running on this environment. Wait for it to finish.");
    const job = {
      id: store.newId(),
      kind,
      environmentId,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      steps: labels.map((label) => ({ label, state: "waiting", note: null })),
      log: [],
      message: null,
      result: null,
    };
    await store.saveJob(job);
    running.set(environmentId, job.id);
    let saving = Promise.resolve();
    const save = () => {
      saving = saving.then(() => store.saveJob(job)).catch(() => {});
      return saving;
    };
    const ctl = {
      jobId: job.id,
      log(line) {
        job.log.push(tidyLog(line));
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        save();
      },
      async step(index, fn, note = null) {
        job.steps[index].state = "running";
        job.steps[index].note = note;
        await save();
        try {
          const value = await fn();
          job.steps[index].state = "done";
          await save();
          return value;
        } catch (error) {
          job.steps[index].state = "failed";
          job.steps[index].note = plainError(error);
          await save();
          throw error;
        }
      },
      skip(index, note) {
        job.steps[index].state = "skipped";
        job.steps[index].note = note;
        return save();
      },
      label(index, label) {
        job.steps[index].label = label;
        return save();
      },
    };
    const finished = (async () => {
      try {
        job.result = (await work(ctl)) ?? null;
        job.status = "succeeded";
      } catch (error) {
        job.status = "failed";
        job.message = plainError(error);
        ctl.log(`Stopped: ${job.message}`);
      } finally {
        job.finishedAt = now();
        running.delete(environmentId);
        await save();
      }
    })();
    active.add(finished);
    finished.finally(() => active.delete(finished));
    return { job, finished };
  }

  // ---------- environments ----------
  async function environment(id) {
    const found = (await store.environments()).find((e) => e.id === id);
    if (!found) throw new Error("That environment is not connected");
    return found;
  }

  async function installTools(ctl, index) {
    await ctl.step(index, async () => {
      const have = await tools.check();
      if (!have.rad) {
        ctl.log(`Downloading Radius CLI ${RADIUS_VERSION}`);
        await tools.install("rad");
      }
      if (!have.k3d) {
        ctl.log("Downloading k3d");
        await tools.install("k3d");
      }
      if (!have.bicep) {
        ctl.log("Downloading Bicep for Radius");
        await tools.installBicep();
      }
    });
  }

  async function installRadius(environment, ctl, index) {
    await ctl.step(index, () =>
      withAccess(environment, async ({ env, config }) => {
        // Without --reinstall, rad leaves an existing installation as it is.
        await must(
          tools.path("rad"),
          ["install", "kubernetes", "--kubecontext", environment.context, "--config", config],
          { env, timeoutMs: 900_000, onLine: ctl.log },
        );
      }),
    );
  }

  async function createRadiusEnvironment(environment, ctl, index) {
    await ctl.step(index, () =>
      withAccess(environment, async ({ env, config }) => {
        const rad = (args, timeoutMs = 120_000) =>
          must(tools.path("rad"), [...args, "--config", config], {
            env,
            timeoutMs,
            onLine: ctl.log,
          });
        await rad(["group", "create", GROUP]);
        await rad([
          "environment",
          "create",
          environment.radiusEnvironment,
          "--group",
          GROUP,
          "--kubernetes-namespace",
          environment.namespace,
        ]);
        if (environment.kind === "local")
          for (const [type, recipe] of LOCAL_RECIPES)
            await rad([
              "recipe",
              "register",
              "default",
              "--environment",
              environment.radiusEnvironment,
              "--group",
              GROUP,
              "--resource-type",
              type,
              "--template-kind",
              "bicep",
              "--template-path",
              `ghcr.io/radius-project/recipes/local-dev/${recipe}:latest`,
            ]);
      }),
    );
  }

  async function freePort(start = 8081) {
    const net = await import("node:net");
    for (let port = start; port < start + 50; port += 1) {
      const ok = await new Promise((resolve) => {
        const s = net.createServer();
        s.once("error", () => resolve(false));
        s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
      });
      if (ok) return port;
    }
    throw new Error("No free port for the local cluster's web address");
  }

  async function connectLocal({ name }) {
    const radiusEnvironment = slug(name);
    if (!NAME.test(radiusEnvironment))
      throw new Error("Give the environment a short name, like test");
    const all = await store.environments();
    if (all.some((e) => e.radiusEnvironment === radiusEnvironment))
      throw new Error(`An environment called ${name} is already connected`);
    const id = store.newId();
    const cluster = `fulcra-${radiusEnvironment}`.slice(0, 32);
    const environment = await store.saveEnvironment({
      id,
      name: String(name).trim(),
      kind: "local",
      cluster,
      context: `k3d-${cluster}`,
      radiusEnvironment,
      namespace: `${radiusEnvironment}-apps`,
      port: null,
      state: "connecting",
      problem: null,
      createdAt: now(),
    });
    await writeRadConfig(environment);
    const { job } = await startJob(
      "connect",
      id,
      [
        "Check Docker is running",
        `Get Radius ${RADIUS_VERSION} and k3d`,
        "Create a local cluster on this Mac",
        "Install Radius on it",
        "Create the Radius environment",
      ],
      async (ctl) => {
        try {
          await ctl.step(0, async () => {
            const have = await tools.check();
            if (!have.docker)
              throw new Error(
                "Docker is not running. Start Docker Desktop (or Colima), then try again.",
              );
          });
          await installTools(ctl, 1);
          await ctl.step(2, async () => {
            const port = await freePort();
            environment.port = port;
            await store.saveEnvironment(environment);
            const listed = await run(
              tools.path("k3d"),
              ["cluster", "list", cluster, "-o", "json"],
              {
                env: tools.env(),
                timeoutMs: 30_000,
              },
            );
            if (listed.code === 0 && listed.stdout.includes(`"name":"${cluster}"`)) {
              ctl.log("The local cluster already exists");
              return;
            }
            await must(
              tools.path("k3d"),
              [
                "cluster",
                "create",
                cluster,
                "--kubeconfig-update-default=false",
                "--kubeconfig-switch-context=false",
                "--wait",
                "--timeout",
                "300s",
                "-p",
                `${port}:80@loadbalancer`,
                "--k3s-arg",
                "--disable=traefik@server:0",
              ],
              { env: tools.env(), timeoutMs: 600_000, onLine: ctl.log },
            );
          });
          await installRadius(environment, ctl, 3);
          await createRadiusEnvironment(environment, ctl, 4);
          environment.state = "ready";
          environment.problem = null;
          await store.saveEnvironment(environment);
          return { environmentId: id };
        } catch (error) {
          environment.state = "failed";
          environment.problem = plainError(error);
          await store.saveEnvironment(environment);
          throw error;
        }
      },
    );
    return { environmentId: id, jobId: job.id };
  }

  async function connectCluster({ name, kubeconfig, context }) {
    if (!secrets?.save)
      throw new Error(
        "This Fulcra host cannot save to the Keychain yet. Update Fulcra, then connect.",
      );
    const radiusEnvironment = slug(name);
    const { names } = kubeconfigContexts(kubeconfig);
    if (!names.includes(context))
      throw new Error("That sign-in file does not have the chosen cluster in it");
    const all = await store.environments();
    if (all.some((e) => e.radiusEnvironment === radiusEnvironment))
      throw new Error(`An environment called ${name} is already connected`);
    const id = store.newId();
    await secrets.save(secretName(id), packKubeconfig(kubeconfig));
    const environment = await store.saveEnvironment({
      id,
      name: String(name).trim(),
      kind: "cluster",
      cluster: null,
      context,
      radiusEnvironment,
      namespace: `${radiusEnvironment}-apps`,
      port: null,
      state: "connecting",
      problem: null,
      createdAt: now(),
    });
    await writeRadConfig(environment);
    // A real cluster is only read here. Installing Radius on it is a separate, confirmed step.
    const { job } = await startJob(
      "connect",
      id,
      [`Get Radius ${RADIUS_VERSION}`, "Reach the cluster", "Check Radius is installed there"],
      async (ctl) => {
        try {
          await installTools(ctl, 0);
          await ctl.step(1, () =>
            withAccess(environment, ({ env, config }) =>
              must(tools.path("rad"), ["group", "list", "--config", config, "-o", "json"], {
                env,
                timeoutMs: 60_000,
              }).catch((error) => {
                if (
                  /not installed|could not find|no such host|connection refused/i.test(
                    error.message,
                  )
                )
                  return;
                throw error;
              }),
            ),
          );
          await ctl.step(2, () =>
            withAccess(environment, async ({ env, config }) => {
              const r = await run(
                tools.path("rad"),
                [
                  "environment",
                  "show",
                  environment.radiusEnvironment,
                  "--group",
                  GROUP,
                  "--config",
                  config,
                  "-o",
                  "json",
                ],
                { env, timeoutMs: 60_000 },
              );
              if (r.code !== 0)
                throw new Error(
                  `Radius has no environment called ${environment.radiusEnvironment} on this cluster yet. Ask your platform team to create it, or install Radius there and create it with rad.`,
                );
            }),
          );
          environment.state = "ready";
          await store.saveEnvironment(environment);
        } catch (error) {
          environment.state = "failed";
          environment.problem = plainError(error);
          await store.saveEnvironment(environment);
          throw error;
        }
      },
    );
    return { environmentId: id, jobId: job.id };
  }

  async function disconnect({ environmentId }) {
    const e = await environment(environmentId);
    if (running.has(e.id)) throw new Error("Wait for the running job to finish first");
    if (e.kind === "cluster" && secrets?.remove) await secrets.remove(secretName(e.id));
    await store.removeEnvironment(e.id);
    // A local cluster keeps running until the person deletes it with k3d; disconnecting never deletes anything.
    return { removed: true, leftRunning: e.kind === "local" ? e.cluster : null };
  }

  // ---------- planning ----------
  async function git(cwd, args, timeoutMs = 60_000) {
    return (await must("git", args, { cwd, env: tools.env(), timeoutMs })).stdout.trim();
  }

  async function webUrl(repo, commit) {
    const remote = await run("git", ["remote", "get-url", "origin"], {
      cwd: repo,
      env: tools.env(),
      timeoutMs: 10_000,
    });
    const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(remote.stdout);
    return m ? `https://github.com/${m[1]}/${m[2]}/commit/${commit}` : null;
  }

  async function resolveRef(repo, ref) {
    if (ref.kind === "pr") {
      const number = Number(ref.value);
      if (!Number.isInteger(number) || number < 1)
        throw new Error("That is not a pull request number");
      const view = await must(
        "gh",
        ["pr", "view", String(number), "--json", "number,title,url,headRefOid,headRefName"],
        { cwd: repo, env: tools.env(), timeoutMs: 30_000 },
      );
      const pr = JSON.parse(view.stdout);
      await run("git", ["fetch", "--quiet", "origin", `pull/${number}/head`], {
        cwd: repo,
        env: tools.env(),
        timeoutMs: 120_000,
      });
      await git(repo, ["cat-file", "-e", `${pr.headRefOid}^{commit}`]).catch(() => {
        throw new Error(
          `Could not get pull request #${number}'s latest commit. Fetch it, then try again.`,
        );
      });
      return {
        kind: "pr",
        label: `#${pr.number} ${pr.title}`,
        commit: pr.headRefOid,
        url: pr.url,
        number: pr.number,
      };
    }
    const value = String(ref.value ?? "").trim();
    if (!value || value.startsWith("-") || /\s/.test(value))
      throw new Error("Choose a branch or commit");
    const commit = await git(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${value}^{commit}`,
    ]).catch(() => {
      throw new Error(
        `There is no ${ref.kind === "branch" ? "branch" : "commit"} called ${value} in this project`,
      );
    });
    return {
      kind: ref.kind === "branch" ? "branch" : "commit",
      label: ref.kind === "branch" ? value : commit.slice(0, 10),
      commit,
      url: await webUrl(repo, commit),
      number: null,
    };
  }

  async function findBicep(repo, commit) {
    const exists = (p) =>
      run("git", ["cat-file", "-e", `${commit}:${p}`], {
        cwd: repo,
        env: tools.env(),
        timeoutMs: 10_000,
      }).then((r) => r.code === 0);
    const config = await run("git", ["show", `${commit}:.fulcra/deploy.json`], {
      cwd: repo,
      env: tools.env(),
      timeoutMs: 10_000,
    });
    if (config.code === 0) {
      const parsed = JSON.parse(config.stdout);
      const file = String(parsed.bicep ?? "");
      if (!file || file.startsWith("/") || file.split("/").includes("..") || !(await exists(file)))
        throw new Error(".fulcra/deploy.json names a Bicep file that is not in this commit");
      return file;
    }
    for (const candidate of BICEP_CANDIDATES) if (await exists(candidate)) return candidate;
    throw new Error(
      `This commit has no Radius app definition. Add app.bicep (or name one in .fulcra/deploy.json), then plan again.`,
    );
  }

  /** Compile the commit's Bicep exactly as committed. */
  async function compile(repo, commit, bicepFile) {
    const dir = await store.scratch();
    try {
      const folder = path.posix.dirname(bicepFile);
      const tar = path.join(dir, "source.tar");
      const paths = folder === "." ? ["."] : [folder];
      const rootConfig = await run("git", ["cat-file", "-e", `${commit}:bicepconfig.json`], {
        cwd: repo,
        env: tools.env(),
        timeoutMs: 10_000,
      });
      if (folder !== "." && rootConfig.code === 0) paths.push("bicepconfig.json");
      await must("git", ["archive", "--format=tar", "-o", tar, commit, "--", ...paths], {
        cwd: repo,
        env: tools.env(),
        timeoutMs: 120_000,
      });
      await must("tar", ["-xf", tar, "-C", dir], { env: tools.env(), timeoutMs: 60_000 });
      const source = path.join(dir, bicepFile);
      const near = path.join(path.dirname(source), "bicepconfig.json");
      if (!(await fsp.stat(near).catch(() => null)) && rootConfig.code !== 0)
        await fsp.writeFile(near, JSON.stringify(DEFAULT_BICEPCONFIG, null, 2));
      const r = await run(tools.bicep, ["build", source, "--stdout"], {
        cwd: path.dirname(source),
        env: tools.env(),
        timeoutMs: 180_000,
      });
      if (r.code !== 0) {
        const first =
          (r.stderr || r.stdout).split("\n").find((l) => /error/i.test(l)) ?? r.stderr.trim();
        throw new Error(`The app definition does not compile: ${first.replace(dir + "/", "")}`);
      }
      return JSON.parse(r.stdout);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  async function liveResources(environment, application) {
    try {
      return await withAccess(environment, async ({ env, config }) => {
        const r = await run(
          tools.path("rad"),
          ["resource", "list", "-a", application, "-g", GROUP, "--config", config, "-o", "json"],
          { env, timeoutMs: 60_000 },
        );
        if (r.code !== 0) return [];
        const rows = JSON.parse(r.stdout || "[]");
        return (Array.isArray(rows) ? rows : []).map((row) => ({ type: row.type, name: row.name }));
      });
    } catch {
      return null;
    }
  }

  async function currentDeployment(environmentId) {
    const history = await store.history(environmentId);
    return history.toReversed().find((d) => d.status === "succeeded") ?? null;
  }

  async function templateOf(deployment) {
    if (!deployment) return null;
    return (await store.plan(deployment.planId))?.template ?? null;
  }

  function digestOf({ environmentId, commit, template, previousDeploymentId }) {
    return sha256(
      canonicalJson({
        environmentId,
        commit,
        template: withoutMetadata(template),
        previousDeploymentId,
      }),
    );
  }

  async function makePlan({
    environment: e,
    template,
    ref,
    source,
    preparedBy,
    rollbackOf = null,
  }) {
    const current = await currentDeployment(e.id);
    const previous = await templateOf(current);
    const firstGuess = planChange({ previous, next: template, local: e.kind === "local" });
    const live = await liveResources(e, firstGuess.application);
    const change = planChange({ previous, next: template, live, local: e.kind === "local" });
    const plan = {
      id: store.newId(),
      environmentId: e.id,
      environmentName: e.name,
      source,
      ref,
      preparedBy,
      rollbackOf,
      createdAt: now(),
      status: "ready",
      statusNote: null,
      previousDeploymentId: current?.id ?? null,
      digest: digestOf({
        environmentId: e.id,
        commit: ref.commit,
        template,
        previousDeploymentId: current?.id ?? null,
      }),
      confirmWord: change.destructive ? confirmWord(e.name) : null,
      template,
      change,
    };
    await store.savePlan(plan);
    return plan;
  }

  /**
   * @param {{ environmentId: string, repo: string, project: string, ref: { kind: "branch"|"commit"|"pr", value: string|number }, preparedBy: { kind: "person" } | { kind: "session", sessionId: string, label: string } }} input
   */
  async function plan({ environmentId, repo, project, ref, preparedBy }) {
    const e = await environment(environmentId);
    if (e.state !== "ready") throw new Error(`${e.name} is not ready yet`);
    const resolved = await resolveRef(repo, ref);
    const bicepFile = await findBicep(repo, resolved.commit);
    const template = await compile(repo, resolved.commit, bicepFile);
    return makePlan({
      environment: e,
      template,
      ref: resolved,
      source: { project, repo, bicep: bicepFile },
      preparedBy,
    });
  }

  async function prepareRollback({ environmentId }) {
    const e = await environment(environmentId);
    const history = (await store.history(e.id)).filter((d) => d.status === "succeeded");
    const current = history[history.length - 1];
    // Roll back to the last good deployment that ran something different from what runs now.
    const target = history
      .toReversed()
      .find(
        (d) =>
          d.id !== current?.id &&
          d.planId !== current?.planId &&
          d.digestTemplate !== current?.digestTemplate,
      );
    if (!current || !target) throw new Error("There is no earlier deployment to roll back to");
    const targetPlan = await store.plan(target.planId);
    if (!targetPlan)
      throw new Error("The earlier deployment's record is missing, so it cannot be rolled back to");
    return makePlan({
      environment: e,
      template: targetPlan.template,
      ref: targetPlan.ref,
      source: targetPlan.source,
      preparedBy: { kind: "person" },
      rollbackOf: current.id,
    });
  }

  async function discard({ planId }) {
    const p = await store.plan(planId);
    if (!p) throw new Error("That plan no longer exists");
    if (p.status === "ready") {
      p.status = "discarded";
      await store.savePlan(p);
    }
    return { discarded: true };
  }

  // ---------- confirm and deploy ----------
  async function confirm({ planId, digest, typed = null }) {
    const p = await store.plan(planId);
    if (!p) throw new Error("That plan no longer exists");
    if (p.status !== "ready")
      throw new Error(`This plan was already ${p.status}. Prepare a new one.`);
    if (p.digest !== digest)
      throw new Error("This is not the plan that was previewed. Look at the preview again.");
    const e = await environment(p.environmentId);
    if (e.state !== "ready") throw new Error(`${e.name} is not ready`);
    if (p.change.destructive && String(typed ?? "").trim() !== p.confirmWord)
      throw new Error(`This deletes things. Type ${p.confirmWord} to confirm.`);
    const stale = async (why) => {
      p.status = "stale";
      p.statusNote = why;
      await store.savePlan(p);
      throw new Error(why);
    };
    const current = await currentDeployment(e.id);
    if ((current?.id ?? null) !== p.previousDeploymentId)
      await stale("Something else was deployed here since this preview. Prepare a new preview.");
    const steps = [
      "Check nothing changed since the preview",
      p.change.changes.filter((c) => c.kind !== "remove").length
        ? `Deploy ${p.change.changes.filter((c) => c.kind !== "remove").length} change${p.change.changes.filter((c) => c.kind !== "remove").length === 1 ? "" : "s"}`
        : "Deploy (nothing to add or update)",
      p.change.changes.some((c) => c.kind === "remove")
        ? `Remove ${p.change.changes
            .filter((c) => c.kind === "remove")
            .map((c) => c.name)
            .join(", ")}`
        : "Remove nothing",
      "Check it is running",
    ];
    const deployment = {
      id: store.newId(),
      planId: p.id,
      environmentId: e.id,
      kind: p.rollbackOf ? "rollback" : "deploy",
      rollbackOf: p.rollbackOf,
      ref: p.ref,
      project: p.source.project,
      summary: p.change.summary,
      digestTemplate: sha256(canonicalJson(withoutMetadata(p.template))),
      preparedBy: p.preparedBy,
      confirmedAt: now(),
      startedAt: now(),
      finishedAt: null,
      status: "running",
      message: null,
      endpoint: null,
      endpointNote: null,
      jobId: null,
    };
    p.status = "deploying";
    await store.savePlan(p);
    const { job } = await startJob(deployment.kind, e.id, steps, async (ctl) => {
      deployment.jobId = ctl.jobId;
      await store.record(e.id, deployment);
      try {
        await ctl.step(0, async () => {
          const live = await liveResources(e, p.change.application);
          const again = planChange({
            previous: await templateOf(current),
            next: p.template,
            live,
            local: e.kind === "local",
          });
          if (canonicalJson(again.changes) !== canonicalJson(p.change.changes))
            throw new Error(
              "The environment no longer matches the preview. Prepare a new preview.",
            );
        });
        await withAccess(e, async ({ env, config, dir }) => {
          const templateFile = path.join(dir, "template.json");
          await fsp.writeFile(templateFile, JSON.stringify(p.template), { mode: 0o600 });
          await ctl.step(1, () =>
            must(
              tools.path("rad"),
              [
                "deploy",
                templateFile,
                "--group",
                GROUP,
                "--environment",
                e.radiusEnvironment,
                "--application",
                p.change.application,
                "--config",
                config,
              ],
              { env, timeoutMs: 1_200_000, onLine: ctl.log },
            ),
          );
          const removals = p.change.changes
            .filter((c) => c.kind === "remove" && c.type !== "applications.core/applications")
            // Containers and gateways first, so nothing is left pointing at a deleted data store.
            .sort(
              (a, b) =>
                Number(/datastores|radius\.data|messaging/.test(a.type)) -
                Number(/datastores|radius\.data|messaging/.test(b.type)),
            );
          if (!removals.length) await ctl.skip(2, "Nothing to remove");
          else
            await ctl.step(2, async () => {
              for (const r of removals) {
                ctl.log(`Removing ${r.name}`);
                await must(
                  tools.path("rad"),
                  [
                    "resource",
                    "delete",
                    r.radiusType,
                    r.name,
                    "-a",
                    p.change.application,
                    "-g",
                    GROUP,
                    "--yes",
                    "--config",
                    config,
                  ],
                  { env, timeoutMs: 600_000, onLine: ctl.log },
                );
              }
            });
          await ctl.step(3, async () => {
            const status = await run(
              tools.path("rad"),
              [
                "application",
                "status",
                p.change.application,
                "-g",
                GROUP,
                "--config",
                config,
                "-o",
                "json",
              ],
              { env, timeoutMs: 60_000 },
            );
            if (status.code !== 0) throw new Error("Radius could not report the app's status");
            const parsed = (() => {
              try {
                return JSON.parse(status.stdout);
              } catch {
                return null;
              }
            })();
            const reported = parsed?.Gateways?.[0]?.Endpoint ?? null;
            const found = reach(e, p.template, reported);
            deployment.endpoint = found.endpoint;
            deployment.endpointNote = found.note;
          });
        });
        deployment.status = "succeeded";
        p.status = "deployed";
        return { deploymentId: deployment.id, endpoint: deployment.endpoint };
      } catch (error) {
        deployment.status = "failed";
        deployment.message = plainError(error);
        p.status = /no longer matches/.test(deployment.message) ? "stale" : "failed";
        p.statusNote = deployment.message;
        throw error;
      } finally {
        deployment.finishedAt = now();
        await store.record(e.id, deployment);
        await store.savePlan(p);
      }
    });
    return { jobId: job.id, deploymentId: deployment.id };
  }

  // ---------- reads ----------
  async function overview() {
    const environments = await store.environments();
    const rows = await Promise.all(
      environments.map(async (e) => {
        const history = await store.history(e.id);
        const current = history.toReversed().find((d) => d.status === "succeeded") ?? null;
        const earlier = history.filter(
          (d) =>
            d.status === "succeeded" &&
            d.id !== current?.id &&
            d.digestTemplate !== current?.digestTemplate,
        );
        return {
          id: e.id,
          name: e.name,
          kind: e.kind,
          state: e.state,
          problem: e.problem,
          where: e.kind === "local" ? "Local test cluster on this Mac" : `Cluster ${e.context}`,
          runningJobId: running.get(e.id) ?? null,
          current,
          canRollBack: Boolean(current && earlier.length),
          history: history.slice(-20).toReversed(),
        };
      }),
    );
    const plans = (await store.plans())
      .slice(0, 50)
      .map(({ template: _template, ...rest }) => rest);
    return { environments: rows, plans };
  }

  async function job({ jobId }) {
    const found = await store.job(jobId);
    if (!found) throw new Error("That job is not known");
    return found;
  }

  async function planView({ planId }) {
    const p = await store.plan(planId);
    if (!p) throw new Error("That plan no longer exists");
    const { template: _template, ...rest } = p;
    return rest;
  }

  return {
    store,
    tools,
    /** Resolves when every job started so far has finished. */
    idle: () => Promise.all([...active]).then(() => undefined),
    overview,
    connectLocal,
    connectCluster,
    disconnect,
    plan,
    prepareRollback,
    planView,
    discard,
    confirm,
    job,
  };
}

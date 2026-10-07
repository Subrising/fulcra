// Deploy records on disk, in the Command Centre's private state folder. Nothing here is a secret: credentials stay
// in the Keychain (connected clusters) or with the tool that made them (local k3d clusters).
//   environments.json           connected environments
//   plans/<id>.json             a prepared plan and its compiled template
//   history/<environment>.json  every deploy and rollback, newest last
//   jobs/<id>.json              live progress of a connect, deploy or rollback
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ID = /^[0-9a-f-]{36}$/;

export function createStore(root) {
  const file = (...parts) => path.join(root, ...parts);
  async function ensure(dir) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  async function readJson(target, fallback) {
    try {
      return JSON.parse(await fsp.readFile(target, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }
  async function writeJson(target, value) {
    await ensure(path.dirname(target));
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await fsp.rename(temporary, target);
  }
  const checked = (id) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Unknown id");
    return id;
  };
  return {
    root,
    newId: () => randomUUID(),
    environments: () => readJson(file("environments.json"), []),
    async saveEnvironment(environment) {
      const all = await readJson(file("environments.json"), []);
      const next = all.filter((e) => e.id !== environment.id);
      next.push(environment);
      await writeJson(file("environments.json"), next);
      return environment;
    },
    async removeEnvironment(id) {
      const all = await readJson(file("environments.json"), []);
      await writeJson(
        file("environments.json"),
        all.filter((e) => e.id !== id),
      );
    },
    plan: (id) => readJson(file("plans", `${checked(id)}.json`), null),
    savePlan: (plan) => writeJson(file("plans", `${checked(plan.id)}.json`), plan),
    async plans() {
      await ensure(file("plans"));
      const names = (await fsp.readdir(file("plans"))).filter((n) => n.endsWith(".json"));
      const all = await Promise.all(names.map((n) => readJson(file("plans", n), null)));
      return all.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    history: (environmentId) => readJson(file("history", `${checked(environmentId)}.json`), []),
    async record(environmentId, deployment) {
      const all = await readJson(file("history", `${checked(environmentId)}.json`), []);
      const next = all.filter((d) => d.id !== deployment.id);
      next.push(deployment);
      next.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      await writeJson(file("history", `${checked(environmentId)}.json`), next.slice(-100));
      return deployment;
    },
    job: (id) => readJson(file("jobs", `${checked(id)}.json`), null),
    saveJob: (job) => writeJson(file("jobs", `${checked(job.id)}.json`), job),
    /** A private scratch folder for one command; the caller removes it. */
    async scratch() {
      await ensure(file("scratch"));
      return fsp.mkdtemp(file("scratch", "run-"));
    },
    exists: (target) => fs.existsSync(target),
  };
}

// Test support only. Runs the REAL startController over a fake owned channel: connectNative is replaced by a local
// fake. node:child_process is wrapped (not replaced) so a test can prove which processes the controller starts.
// Everything else (HostNative wiring, the journal, the operator socket, events-status) is the shipped code.
// One startController per process: the owned process lock is held until exit.
import { mock } from "node:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
const control = new URL("../src/control/", import.meta.url);
export async function startWithBookFixture() {
  const realNative = await import(new URL("native.mjs?real", control).href);
  const calls = [],
    processes = [];
  const realChild = await import("node:child_process");
  const record =
    (name) =>
    (command, ...rest) => {
      processes.push({
        via: name,
        command: String(command),
        args: Array.isArray(rest[0]) ? rest[0] : [],
      });
      return realChild[name](command, ...rest);
    };
  mock.module("node:child_process", {
    namedExports: {
      ...realChild,
      ...Object.fromEntries(
        ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"].map((n) => [
          n,
          record(n),
        ]),
      ),
    },
    defaultExport: realChild.default,
  });
  const local = {
    currentBoot: () => "fixture-boot",
    subscribe: () => () => {},
    watch: async () => {},
    close: async () => {},
    reconcile: async () => {},
    create: async (a) => {
      calls.push({ local: "create", host: a.host ?? null });
      return { id: randomUUID(), cwd: "/tmp/local" };
    },
  };
  mock.module(new URL("native.mjs", control).href, {
    namedExports: { ...realNative, connectNative: async () => local },
  });
  const { startController } = await import(new URL("server.mjs", control).href);
  const { socketLocation } = await import(new URL("socket-location.mjs", control).href);
  const HOME = realNative.HOME;
  const exit = mock.method(process, "exit", () => {}),
    before = new Set(process.listeners("exit"));
  let management; // the owned-channel management dispatcher the controller registers with its host
  const started = await startController({
    daemon: {},
    issueProvenance: async () => "token",
    registerManagement: (handler) => {
      management = handler;
      return () => {};
    },
    epoch: randomUUID(),
    getHandshakeBoot: () => "fixture-boot",
  });
  // The controller releases its process lock on exit; run that at stop, before the harness removes the fixture home.
  const release = () => {
    for (const l of process.listeners("exit").filter((l) => !before.has(l))) {
      process.removeListener("exit", l);
      l();
    }
  };
  // A read over the owned child's operator socket, exactly as a same-user operator client sends it.
  const operatorRead = (method) =>
    new Promise((resolve, reject) => {
      const credential = fs
        .readFileSync(path.join(HOME, ["operator", "secret"].join(".")), "utf8")
        .trim();
      const c = net.createConnection(socketLocation(HOME).socket);
      let out = "";
      c.setEncoding("utf8");
      c.on("data", (d) => {
        out += d;
      });
      c.on("error", reject);
      c.on("end", () => {
        try {
          const r = JSON.parse(out);
          if (r.error) reject(Error(r.error));
          else resolve(r.result);
        } catch (e) {
          reject(e);
        }
      });
      c.end(JSON.stringify({ method, operator: credential }) + "\n");
    });
  return {
    ...started,
    HOME,
    calls,
    processes,
    operatorRead,
    management: (command, principal) => management(command, principal),
    stop: async () => {
      await started.stop();
      release();
      exit.mock.restore();
    },
  };
}

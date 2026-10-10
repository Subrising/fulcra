import { localMachine } from "../local-machine.mjs";
import { portable } from "../portable-config.mjs";
import fs from "node:fs";
import { privateOwned } from "../../orca-organization/server/owned.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bindGuardHome } from "./native-release-hooks.mjs";
const HOME = portable?.controller ?? localMachine("legacyControllerHome");
export function verifyActivation() {
  return verifyActivationAt(HOME, portable?.daemon.port ?? 6791);
}
// Explicit private-runtime verification uses the same checks as the fixed
// production entrypoint; no caller-supplied guard digest or PID is accepted.
export function verifyActivationAt(home, port) {
  if (
    !path.isAbsolute(home) ||
    path.resolve(home) !== home ||
    fs.realpathSync(home) !== home ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw Error("Canonical controller home and valid native port required");
  const owner = fs.lstatSync(home);
  if (!owner.isDirectory() || !privateOwned(owner, home))
    throw Error("Private owned controller home required");
  const active = JSON.parse(fs.readFileSync(`${home}/admission/active.json`, "utf8"));
  const guard = bindGuardHome(
    fs.readFileSync(new URL("./admission-guard.mjs", import.meta.url), "utf8"),
    home,
  );
  if (active.guard?.sha256 !== createHash("sha256").update(guard).digest("hex"))
    throw Error("Running admission guard does not match this controller release");
  const listeners = [
    ...new Set(
      execFileSync(
        portable ? "lsof" : "/usr/sbin/lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\s+/),
    ),
  ];
  if (listeners.length !== 1 || !/^[0-9]+$/.test(listeners[0]))
    throw new Error("Expected one native Paseo listener");
  const loaded = JSON.parse(
    fs.readFileSync(`${home}/admission/loaded-${listeners[0]}.json`, "utf8"),
  );
  for (const [file, expected] of Object.entries({
    ...active.files,
    ...Object.fromEntries(
      Object.entries(active.after).map(([name, value]) => [active.base + name, value]),
    ),
    [active.guard.path]: active.guard.sha256,
  })) {
    if (
      !fs.lstatSync(file).isFile() ||
      createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== expected
    )
      throw new Error("Native admission guard is missing or changed");
  }
  const processStart = execFileSync("/bin/ps", ["-p", String(loaded.pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
  if (
    !listeners.includes(String(loaded.pid)) ||
    !processStart ||
    processStart !== loaded.processStart ||
    loaded.guard !== active.guard.sha256 ||
    Object.entries(active.after).some(([name, hash]) => loaded.modules[name] !== hash) ||
    !loaded.boot
  )
    throw new Error("Running Paseo has not loaded the reviewed admission guard");
  return loaded.boot;
}
// STAGE2 review F1. A native daemon is listening but is NOT the verified release -- no receipt, another guard,
// unpatched modules -- or several are. Such a boot may not run the Stage 2 guard, which is what disarms the
// human-input chain, so the controller must break the chain on its behalf. No listener at all is simply a
// daemon that is down (a restart in progress) and is not evidence of anything, so it answers false; so does
// a listener query that itself fails, because this function only ever decides whether to break the chain.
export function unverifiedListener(home = HOME, port = portable?.daemon.port ?? 6791) {
  let listeners;
  try {
    listeners = execFileSync(
      portable ? "lsof" : "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return false;
  }
  if (!listeners) return false;
  try {
    verifyActivationAt(home, port);
    return false;
  } catch {
    return true;
  }
}

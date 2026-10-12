import { createRequire } from "node:module";
import path from "node:path";
import { resolveBuiltinPluginsRoot } from "../plugins/builtin/index.js";

interface Modules {
  detect: typeof import("../../../../../plugins/fulcra-agent-policy/server/detect.mjs");
  "parse-reset": typeof import("../../../../../plugins/fulcra-agent-policy/server/parse-reset.mjs");
  service: typeof import("../../../../../plugins/fulcra-agent-policy/server/service.mjs");
  hooks: typeof import("../../../../../plugins/fulcra-agent-policy/index.host.mjs");
  "report-observer": typeof import("../../../../../plugins/fulcra-agent-policy/server/report-observer.mjs");
  "report-notices": typeof import("../../../../../plugins/fulcra-agent-policy/server/report-notices.mjs");
}
const require = createRequire(import.meta.url);

/** Immutable distribution resources. Node 22.20 supports these synchronous ESM policy modules. */
export function loadAgentPolicy<Name extends keyof Modules>(name: Name): Modules[Name] {
  const root = path.join(resolveBuiltinPluginsRoot(), "fulcra-agent-policy");
  const file =
    name === "hooks" ? path.join(root, "index.host.mjs") : path.join(root, "server", `${name}.mjs`);
  return require(file) as Modules[Name];
}

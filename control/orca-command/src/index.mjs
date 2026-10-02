import { definePluginEntry, buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { createCommand, commandOrigin } from "./command.mjs";
import { createWorkspace } from "./workspace.mjs";
import { request } from "../../orca-ingress/src/controller-client.mjs";
import { managementWrites, managementWriter } from "../../orca-ingress/src/management-client.mjs";
export default definePluginEntry({
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema, {
    cacheKey: "orca-command:config",
  }),
  register(api) {
    const config = api.pluginConfig;
    // Cutover A2: /orca delegate (handback) through the daemon management channel ONLY if the gateway environment selects the
    // owned child (ORCA_CONTROLLER_TOPOLOGY=owned-child): that makes the gateway a management caller with the owner daemon
    // credential -- a trust decision taken at the window, not by default. Unset: the legacy operator lane, unchanged.
    const workspace = createWorkspace({
      config,
      baseOrigin: commandOrigin(config),
      request,
      write: managementWrites() ? managementWriter() : null,
    });
    const command = createCommand({ config, request, workspace });
    api.registerService(command.service);
    api.registerCommand(command.definition);
  },
});

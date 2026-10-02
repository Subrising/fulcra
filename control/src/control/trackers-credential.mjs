// J3 operator credential setup (Q6: CLI first, never mobile). Run in the operator's own terminal:
//
//   node src/control/trackers-credential.mjs set|status|delete github
//   node src/control/trackers-credential.mjs set|status|delete jira <site>.atlassian.net
//   node src/control/trackers-credential.mjs set|status|delete bitbucket
//
// `set` hands the terminal to /usr/bin/security with `-w` LAST and no value, so security prompts with echo
// off: the token never appears in argv (visible to ps), in this process, or in any output. `status` never
// passes -w or -g, so the secret is not even read; it reports presence only. The keychain service is the
// product's per-plugin namespace (ai.fulcra.plugin.<pluginId>). The host binds it to the plugin's RUNTIME
// installation id, which defaults to the manifest id (read from paseo-plugin.json, never restated here); if the
// plugin was installed with `--id <other>`, set ORCA_TRACKERS_PLUGIN_ID=<other> so the item lands where it reads.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { credentialAccount, TRACKERS } from "../../orca-organization/shared/tracker-refs.mjs";
const MANIFEST = new URL("../../orca-organization/paseo-plugin.json", import.meta.url);
export function manifestPluginId(read = () => readFileSync(MANIFEST, "utf8")) {
  const id = JSON.parse(read())?.id;
  if (typeof id !== "string" || !id) throw new Error("The plugin manifest has no id");
  return id;
}
export function serviceFor(pluginId = process.env.ORCA_TRACKERS_PLUGIN_ID ?? manifestPluginId()) {
  if (!/^[a-z][a-z0-9._-]*$/.test(pluginId)) throw new Error("Invalid plugin id");
  return `ai.fulcra.plugin.${pluginId}`;
}
export const SERVICE = serviceFor(manifestPluginId());
// J0-5: where this CLI stored tokens before J0 read the plugin id from the manifest. The plugin never read it, so a
// token there is an orphan. It is only ever probed for presence (never read) or deleted, and only this exact service.
export const LEGACY_SERVICE = "ai.fulcra.plugin.orca-organization";
export const LEGACY_HINT =
  "A token was saved under the old name, where Fulcra cannot read it. Run set again, then delete-legacy";
const SITE = { github: "github.com", bitbucket: "bitbucket.org" };
export function credentialCommand(action, tracker, site = SITE[tracker], service = serviceFor()) {
  if (!TRACKERS.includes(tracker)) throw new Error("Unknown tracker");
  const account = credentialAccount(tracker, site);
  if (action === "set") return ["add-generic-password", "-U", "-s", service, "-a", account, "-w"];
  if (action === "status") return ["find-generic-password", "-s", service, "-a", account];
  if (action === "delete") return ["delete-generic-password", "-s", service, "-a", account];
  if (action === "status-legacy")
    return ["find-generic-password", "-s", LEGACY_SERVICE, "-a", account];
  if (action === "delete-legacy")
    return ["delete-generic-password", "-s", LEGACY_SERVICE, "-a", account];
  throw new Error("Usage: set|status|delete|delete-legacy <github|jira|bitbucket> [site]");
}
export function runCredential(action, tracker, site, exec = execFileSync) {
  if (action === "status-legacy")
    throw new Error("Usage: set|status|delete|delete-legacy <github|jira|bitbucket> [site]");
  const args = credentialCommand(action, tracker, site),
    account = args[args.indexOf("-a") + 1];
  if (action === "set") {
    exec("/usr/bin/security", args, { stdio: "inherit" });
    return { tracker, account, stored: true };
  }
  const quiet = (a) => {
    try {
      exec("/usr/bin/security", a, { stdio: ["ignore", "ignore", "ignore"] });
      return true;
    } catch (error) {
      if (error?.status === 44) return false;
      throw new Error("Keychain command failed");
    }
  };
  const found = quiet(args);
  if (action !== "status") return { tracker, account, deleted: found };
  // J0-5: when nothing is where the plugin reads, say whether an orphan sits under the old name (presence only).
  if (
    !found &&
    serviceFor() !== LEGACY_SERVICE &&
    quiet(credentialCommand("status-legacy", tracker, site))
  )
    return { tracker, account, present: false, legacy: true, hint: LEGACY_HINT };
  return { tracker, account, present: found };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, tracker, site] = process.argv.slice(2);
  console.log(JSON.stringify(runCredential(action, tracker, site)));
}

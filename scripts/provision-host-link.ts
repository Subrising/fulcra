#!/usr/bin/env -S node --import tsx
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HostLinkConfigSchema,
  type HostLinkConfig,
} from "../packages/server/src/server/host-link-contracts.js";
import { writePrivateFileAtomicSync } from "../packages/server/src/server/private-files.js";

const empty = (machine: "mac" | "pc"): HostLinkConfig => ({
  version: 1,
  machine,
  chats: [],
  incoming: [],
  outgoing: [],
  routes: {},
});
function config(value: unknown): HostLinkConfig {
  const result = HostLinkConfigSchema.safeParse(value);
  if (!result.success) throw new Error("Host-link configuration is invalid.");
  return result.data;
}
function privateRead(file: string): unknown {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error("A private owner file is required.");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Prepare two private fragments. This command never writes a daemon home. */
export function prepare(
  plan: {
    sourceServerId: string;
    targetServerId: string;
    leadId: string;
    linkId: string;
    url: string;
    expiresAt: number;
    workspace: string;
    directory: string;
    profile: string;
    worker: HostLinkConfig["incoming"][number]["profiles"][string];
    maxWorkers: number;
  },
  output: string,
): void {
  if (process.platform === "win32") throw new Error("Prepare credentials on the source Mac.");
  const url = new URL(plan.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use an HTTPS host origin.");
  if (plan.sourceServerId === plan.targetServerId || plan.expiresAt <= Date.now())
    throw new Error("Use different hosts and a future expiry.");
  const token = (prefix: string) => `${prefix}.${randomBytes(32).toString("base64url")}`;
  const lifetime = { expiresAt: plan.expiresAt, revoked: false };
  const linkToken = token("hlink1");
  const source = empty("mac");
  source.chats.push({
    agentId: plan.leadId,
    token: token("hchat1"),
    ...lifetime,
    operations: ["spawn"],
    links: [plan.linkId],
  });
  source.outgoing.push({
    id: plan.linkId,
    serverId: plan.targetServerId,
    url: url.origin,
    token: linkToken,
    ...lifetime,
    machine: "pc",
    reporters: [],
  });
  source.routes.standard = plan.linkId;
  const target = empty("pc");
  target.incoming.push({
    id: plan.linkId,
    serverId: plan.sourceServerId,
    token: linkToken,
    ...lifetime,
    leads: [plan.leadId],
    operations: ["spawn"],
    workloads: ["standard"],
    workspaces: { [plan.workspace]: plan.directory },
    profiles: { [plan.profile]: plan.worker },
    maxWorkers: plan.maxWorkers,
  });
  config(source);
  config(target);
  mkdirSync(output, { mode: 0o700 }); // Exclusive directory: never overwrite an earlier credential pair.
  for (const [name, value] of [
    ["source", source],
    ["target", target],
  ] as const)
    writeFileSync(path.join(output, `${name}.json`), `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
}

/** Apply on each host from stdin over SSH. No credentials enter command arguments. */
export function apply(home: string, fragment: unknown): void {
  const patch = config(fragment);
  const file = path.join(home, "host-links.json");
  let current = empty(patch.machine);
  try {
    current = config(privateRead(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current.machine !== patch.machine) throw new Error("Host machine roles differ.");
  for (const section of ["incoming", "outgoing"] as const) {
    for (const entry of patch[section]) {
      if (current[section].some((old) => old.id === entry.id))
        throw new Error("The link already exists. Reconcile the retained configuration.");
    }
  }
  for (const chat of patch.chats) {
    const old = current.chats.find((entry) => entry.agentId === chat.agentId);
    if (old) {
      if (old.revoked || old.expiresAt <= Date.now())
        throw new Error("The existing chat grant is inactive.");
      old.links = [...new Set([...old.links, ...chat.links])];
      old.operations = [...new Set([...old.operations, ...chat.operations])];
    } else current.chats.push(chat);
  }
  current.incoming.push(...patch.incoming);
  current.outgoing.push(...patch.outgoing);
  // A named serverId selects the new link. Preserve existing workload routes.
  for (const [workload, link] of Object.entries(patch.routes))
    if (!Object.hasOwn(current.routes, workload))
      Object.assign(current.routes, { [workload]: link });
  writePrivateFileAtomicSync(file, `${JSON.stringify(config(current), null, 2)}\n`, {
    durable: true,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [operation, input, output] = process.argv.slice(2);
    if (operation === "prepare" && input && output)
      prepare(privateRead(input) as Parameters<typeof prepare>[0], path.resolve(output));
    else if (operation === "apply" && input && !output)
      apply(path.resolve(input), JSON.parse(readFileSync(0, "utf8")));
    else throw new Error("Use prepare PLAN OUTPUT or apply HOME with a fragment on stdin.");
    process.stdout.write("Host-link provisioning completed. No credentials were printed.\n");
  } catch {
    process.stderr.write(
      "Host-link provisioning failed. Retain the private files and reconcile before retry.\n",
    );
    process.exitCode = 1;
  }
}

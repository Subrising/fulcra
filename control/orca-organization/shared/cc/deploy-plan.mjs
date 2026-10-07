// Deploy from Fulcra: the change plan. Pure and shared by the server (which plans) and the app (which shows it).
// Radius has no what-if, so the plan compares two compiled Bicep templates: the one last deployed to the
// environment and the one about to be. Each resource is keyed by its type (without API version) and name. Anything
// running in the environment that neither template mentions is reported, never deleted.

const TYPE_LABELS = {
  "applications.core/applications": "application",
  "applications.core/containers": "container",
  "applications.core/gateways": "public address",
  "applications.core/volumes": "volume",
  "applications.core/secretstores": "secret store",
  "applications.core/extenders": "extender",
  "applications.datastores/rediscaches": "Redis cache",
  "applications.datastores/sqldatabases": "SQL database",
  "applications.datastores/mongodatabases": "MongoDB database",
  "applications.messaging/rabbitmqqueues": "RabbitMQ queue",
  "radius.data/postgresqldatabases": "Postgres database",
  "radius.data/mysqldatabases": "MySQL database",
  "radius.data/rediscaches": "Redis cache",
  "radius.compute/containers": "container",
  "radius.compute/persistentvolumes": "volume",
  "radius.security/secrets": "secret store",
};
// Types whose removal deletes stored data, not just a running copy.
const DATA =
  /^(applications\.datastores|applications\.messaging|radius\.data)\/|\/(volumes|persistentvolumes|secretstores|secrets)$/;

export function baseType(type) {
  return String(type).split("@")[0].toLowerCase();
}

export function typeLabel(type) {
  const base = baseType(type);
  if (TYPE_LABELS[base]) return TYPE_LABELS[base];
  const last = base.split("/").pop() ?? base;
  return last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/s$/, "");
}

export function holdsData(type) {
  return DATA.test(baseType(type));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const REFERENCE = /reference\('([^']+)'\)/g;

/** The resources of a compiled template, keyed `type/name`, with the connections between them. */
export function readTemplate(template) {
  const raw = template?.resources;
  const entries = Array.isArray(raw)
    ? raw.map((r, i) => [r?.symbolicName ?? String(i), r])
    : Object.entries(raw && typeof raw === "object" ? raw : {});
  const bySymbol = new Map();
  const resources = [];
  for (const [symbol, r] of entries) {
    if (!r || typeof r.type !== "string") continue;
    const name = typeof r.properties?.name === "string" ? r.properties.name : (r.name ?? symbol);
    const key = `${baseType(r.type)}/${name}`;
    bySymbol.set(symbol, key);
    resources.push({
      key,
      symbol,
      type: baseType(r.type),
      radiusType: String(r.type).split("@")[0],
      name,
      body: r.properties?.properties ?? {},
    });
  }
  const links = [];
  for (const r of resources) {
    const text = JSON.stringify(r.body?.connections ?? {});
    for (const m of text.matchAll(REFERENCE)) {
      const to = bySymbol.get(m[1]);
      if (to && to !== r.key && !links.some((l) => l.from === r.key && l.to === to))
        links.push({ from: r.key, to });
    }
    // Gateways route to containers, by reference or by a URL naming the container ("http://web:80").
    for (const route of Array.isArray(r.body?.routes) ? r.body.routes : []) {
      const text = JSON.stringify(route ?? {});
      let to = [...text.matchAll(REFERENCE)].map((m) => bySymbol.get(m[1])).find(Boolean) ?? null;
      const host = /^https?:\/\/([^:/]+)/.exec(String(route?.destination ?? ""))?.[1];
      if (!to && host)
        to = resources.find((x) => x.type.endsWith("/containers") && x.name === host)?.key ?? null;
      if (to && to !== r.key && !links.some((l) => l.from === r.key && l.to === to))
        links.push({ from: r.key, to });
    }
  }
  // Without the application's own id field, the body still mentions reference('app').id; that is ownership,
  // not a connection, and it is not drawn.
  return { resources, links };
}

function imageOf(body) {
  return typeof body?.container?.image === "string" ? body.container.image : null;
}

/** Plain lines saying what changes inside one resource. Values of settings are never shown: they may be secret. */
export function describeUpdate(type, before, after) {
  const lines = [];
  const oldImage = imageOf(before),
    newImage = imageOf(after);
  if (oldImage !== newImage) lines.push(`Image ${oldImage ?? "none"} → ${newImage ?? "none"}`);
  const portsOf = (b) =>
    Object.values(b?.container?.ports ?? {})
      .map((p) => p?.containerPort)
      .filter((p) => p != null)
      .sort();
  if (!same(portsOf(before), portsOf(after)))
    lines.push(
      `Ports ${portsOf(before).join(", ") || "none"} → ${portsOf(after).join(", ") || "none"}`,
    );
  const envOf = (b) => b?.container?.env ?? {};
  const envNames = new Set([...Object.keys(envOf(before)), ...Object.keys(envOf(after))]);
  const envChanged = [...envNames].filter((n) => !same(envOf(before)[n], envOf(after)[n])).sort();
  if (envChanged.length) lines.push(`Settings changed: ${envChanged.join(", ")}`);
  const conns = (b) => Object.keys(b?.connections ?? {}).sort();
  const added = conns(after).filter((c) => !conns(before).includes(c));
  const removed = conns(before).filter((c) => !conns(after).includes(c));
  if (added.length) lines.push(`Now connects to ${added.join(", ")}`);
  if (removed.length) lines.push(`No longer connects to ${removed.join(", ")}`);
  if (baseType(type).endsWith("/gateways")) {
    const host = (b) => b?.hostname?.fullyQualifiedHostname ?? b?.hostname?.prefix ?? null;
    if (!same(before?.hostname, after?.hostname))
      lines.push(`Web address ${host(before) ?? "default"} → ${host(after) ?? "default"}`);
    if (!same(before?.routes, after?.routes)) lines.push("Its routes change");
  }
  const known = new Set(["container", "connections", "hostname", "routes"]);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const other = [...keys].filter((k) => !known.has(k) && !same(before?.[k], after?.[k])).sort();
  const containerOther = [
    ...new Set([...Object.keys(before?.container ?? {}), ...Object.keys(after?.container ?? {})]),
  ]
    .filter((k) => !["image", "ports", "env"].includes(k))
    .filter((k) => !same(before?.container?.[k], after?.container?.[k]));
  const rest = [...other, ...containerOther].sort();
  if (rest.length) lines.push(`Also changes ${rest.join(", ")}`);
  return lines.length ? lines : ["Its definition changes"];
}

/** "the web container", "the Redis cache (cache)": how a sentence names one part. */
const nameOf = (c) =>
  c.label === "container" ? `the ${c.name} container` : `the ${c.label} (${c.name})`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function joinWords(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function phrase(group, verb) {
  // Group same-type changes so five containers read as "5 containers (a, b, c, d, e)".
  const byLabel = new Map();
  for (const c of group) byLabel.set(c.label, [...(byLabel.get(c.label) ?? []), c.name]);
  const parts = [...byLabel].map(([label, names]) => {
    if (names.length > 1) return `${plural(names.length, label)} (${names.join(", ")})`;
    if (verb === "adds") return `a ${label} (${names[0]})`;
    return nameOf({ label, name: names[0] });
  });
  return `${verb} ${joinWords(parts)}`;
}

export function summarise(changes, { first = false, application = "" } = {}) {
  const visible = changes.filter((c) => c.type !== "applications.core/applications");
  if (!changes.length) return "Nothing changes. What is running already matches this version.";
  if (!visible.length) return `Updates the ${application} application's own settings.`;
  const clauses = [];
  const adds = visible.filter((c) => c.kind === "add"),
    updates = visible.filter((c) => c.kind === "update"),
    removes = visible.filter((c) => c.kind === "remove");
  if (adds.length) clauses.push(phrase(adds, "adds"));
  if (updates.length) clauses.push(phrase(updates, "updates"));
  if (removes.length) clauses.push(phrase(removes, "removes"));
  const sentence =
    clauses.length > 1
      ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`
      : clauses[0];
  const lead = first ? `First deploy of ${application}: ` : "";
  return `${lead}${first ? sentence : sentence[0].toUpperCase() + sentence.slice(1)}.`;
}

/**
 * Compare what is deployed with what would be.
 * @param {{ previous: object | null, next: object, live?: {type: string, name: string}[] | null, local?: boolean }} input
 */
export function planChange({ previous, next, live = null, local = true }) {
  const before = readTemplate(previous ?? {}),
    after = readTemplate(next);
  const old = new Map(before.resources.map((r) => [r.key, r])),
    now = new Map(after.resources.map((r) => [r.key, r]));
  const keys = [...new Set([...old.keys(), ...now.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const a = old.get(key) ?? null,
      b = now.get(key) ?? null;
    const r = b ?? a;
    const base = {
      key,
      type: r.type,
      radiusType: r.radiusType,
      name: r.name,
      label: typeLabel(r.type),
    };
    if (!a)
      changes.push({ ...base, kind: "add", details: [], destructive: false, deletesData: false });
    else if (!b)
      changes.push({
        ...base,
        kind: "remove",
        details: [holdsData(r.type) ? "Deletes it and the data in it" : "Stops and deletes it"],
        destructive: true,
        deletesData: holdsData(r.type),
      });
    else if (!same(a.body, b.body))
      changes.push({
        ...base,
        kind: "update",
        details: describeUpdate(r.type, a.body, b.body),
        destructive: false,
        deletesData: false,
      });
  }
  const application =
    after.resources.find((r) => r.type === "applications.core/applications")?.name ??
    before.resources.find((r) => r.type === "applications.core/applications")?.name ??
    "app";
  const changed = new Map(changes.map((c) => [c.key, c.kind]));
  const allLinks = [...before.links, ...after.links].filter(
    (l, i, all) => all.findIndex((m) => m.from === l.from && m.to === l.to) === i,
  );
  // Blast radius: anything wired to a changed part is affected by it.
  const affected = new Set();
  for (const l of allLinks) {
    if (changed.has(l.to) && !changed.has(l.from)) affected.add(l.from);
    if (changed.has(l.from) && !changed.has(l.to)) affected.add(l.to);
  }
  const state = (key) =>
    changed.get(key) === "add"
      ? "new"
      : changed.get(key) === "update"
        ? "changed"
        : changed.get(key) === "remove"
          ? "removed"
          : affected.has(key)
            ? "affected"
            : "same";
  const parts = keys
    .map((key) => now.get(key) ?? old.get(key))
    .filter((r) => r.type !== "applications.core/applications")
    .map((r) => ({ id: r.key, name: r.name, label: typeLabel(r.type), state: state(r.key) }));
  const links = allLinks.map((l) => ({
    from: l.from,
    to: l.to,
    state: !after.links.some((m) => m.from === l.from && m.to === l.to)
      ? "removed"
      : !before.links.some((m) => m.from === l.from && m.to === l.to) && previous
        ? "new"
        : "same",
  }));
  const risks = [];
  for (const c of changes) {
    if (c.kind === "remove" && c.deletesData)
      risks.push(`Deletes ${nameOf(c)} and everything stored in it. This cannot be undone.`);
    else if (c.kind === "remove") risks.push(`Deletes ${nameOf(c)}.`);
    if (c.kind === "update" && c.type.endsWith("/containers"))
      risks.push(`The ${c.name} container restarts while it updates.`);
  }
  for (const r of after.resources) {
    const image = imageOf(r.body);
    if (image && (image.endsWith(":latest") || !/[:@]/.test(image.split("/").pop() ?? "")))
      risks.push(
        `${r.name} uses an image without a fixed version, so a later deploy may run different code.`,
      );
  }
  const notes = [];
  if (local) notes.push("This is a local test cluster on this Mac, so nothing here costs money.");
  else if (changes.some((c) => c.kind === "add" && holdsData(c.type)))
    notes.push(
      "Radius gives no cost estimate. A new database or cache may create a billed cloud service, depending on the environment's recipes.",
    );
  else notes.push("Radius gives no cost estimate for this change.");
  const unmanaged = (live ?? []).filter(
    (r) => !now.has(`${baseType(r.type)}/${r.name}`) && !old.has(`${baseType(r.type)}/${r.name}`),
  );
  if (unmanaged.length)
    notes.push(
      `${plural(unmanaged.length, "resource")} in this environment ${unmanaged.length === 1 ? "was" : "were"} not deployed from Fulcra (${unmanaged.map((r) => r.name).join(", ")}). Fulcra leaves ${unmanaged.length === 1 ? "it" : "them"} alone.`,
    );
  return {
    application,
    first: !previous,
    summary: summarise(changes, { first: !previous, application }),
    changes,
    unchanged: keys.filter((k) => !changed.has(k)).length,
    destructive: changes.some((c) => c.destructive),
    deletesData: changes.some((c) => c.deletesData),
    risks,
    notes,
    map: { parts, links },
  };
}

/** What a person types to confirm a plan that deletes something: the environment's name. */
export function confirmWord(environmentName) {
  return String(environmentName).trim();
}

/** The contexts a pasted kubeconfig offers, read without a YAML library: only the names are needed. */
export function kubeconfigContexts(text) {
  const names = [];
  const block = /^contexts:\s*\n((?:[ \t-].*\n?)*)/m.exec(text)?.[1] ?? "";
  for (const m of block.matchAll(/^\s*name:\s*["']?([^"'\n]+?)["']?\s*$/gm)) names.push(m[1]);
  const current = /^current-context:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1] ?? null;
  return { names, current };
}

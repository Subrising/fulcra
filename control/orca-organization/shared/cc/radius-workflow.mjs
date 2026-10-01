// Local planning only. No provider, environment, credential, filesystem or command access.
export const RADIUS_TARGET = "0.61.x";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const IMAGE = /^[a-z0-9][a-z0-9./_-]{0,180}(?::[A-Za-z0-9_.-]{1,40}|@sha256:[a-f0-9]{64})$/;
const refuse = () => {
  throw new Error("Radius scratch input is invalid or exceeds its limits.");
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    refuse();
}
function name(value) {
  if (typeof value !== "string" || !NAME.test(value)) refuse();
  return value;
}
function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) refuse();
  return value;
}
function list(value, parse, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 16) refuse();
  const result = value.map(parse).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(result.map((v) => v.id)).size !== result.length) refuse();
  return result;
}
function resource(value) {
  exact(value, ["id", "image", "port"]);
  if (
    typeof value.image !== "string" ||
    !IMAGE.test(value.image) ||
    value.image.includes("..") ||
    value.image.endsWith(":latest")
  )
    refuse();
  return { id: name(value.id), image: value.image, port: port(value.port) };
}
function requirement(value) {
  exact(value, ["id", "resourceId", "port"]);
  return { id: name(value.id), resourceId: name(value.resourceId), port: port(value.port) };
}
function draft(value) {
  exact(value, ["application", "requirements", "current", "proposed"]);
  return {
    application: name(value.application),
    requirements: list(value.requirements, requirement, 1),
    current: list(value.current, resource),
    proposed: list(value.proposed, resource, 1),
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function planRadiusChange(input) {
  const definition = draft(input),
    old = new Map(definition.current.map((r) => [r.id, r])),
    next = new Map(definition.proposed.map((r) => [r.id, r]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((id) => {
    const before = old.get(id) ?? null,
      after = next.get(id) ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    let kind = "update";
    if (before === null) kind = "add";
    else if (after === null) kind = "remove";
    return [{ id, kind, before, after }];
  });
  return freeze({
    target: RADIUS_TARGET,
    definition,
    revision: JSON.stringify(definition),
    changes,
  });
}
export function validateRadiusPlan(plan, expectedRevision) {
  exact(plan, ["target", "definition", "revision", "changes"]);
  const rebuilt = planRadiusChange(plan.definition);
  if (
    plan.target !== RADIUS_TARGET ||
    plan.revision !== expectedRevision ||
    JSON.stringify(plan) !== JSON.stringify(rebuilt)
  )
    refuse();
  const requirements = rebuilt.definition.requirements.map((r) => ({
    id: r.id,
    state: rebuilt.definition.proposed.some((v) => v.id === r.resourceId && v.port === r.port)
      ? "pass"
      : "fail",
  }));
  return freeze({
    kind: requirements.every((r) => r.state === "pass") ? "valid" : "blocked",
    requirements,
    basis: "local-structural-validation",
    nativeCompilation: "not_run",
    environmentDeployment: "held",
  });
}
export function radiusScratchFiles(plan, expectedRevision) {
  const validation = validateRadiusPlan(plan, expectedRevision);
  if (validation.kind !== "valid")
    throw new Error("The proposed infrastructure does not meet its requirements.");
  // Applications.Core is the retained resource family supported by Radius 0.61.
  // Native Radius/Bicep compilation must occur separately before any real deployment.
  const containers = plan.definition.proposed
    .map(
      (r, i) =>
        `resource container${i} 'Applications.Core/containers@2023-10-01-preview' = {\n  name: '${r.id}'\n  properties: {\n    application: application.id\n    container: {\n      image: '${r.image}'\n      ports: {\n        web: { containerPort: ${r.port} }\n      }\n    }\n  }\n}\n`,
    )
    .join("\n");
  const bicep = `// Local scratch definition. No environment has been deployed.\nparam environment string\n\nresource application 'Applications.Core/applications@2023-10-01-preview' = {\n  name: '${plan.definition.application}'\n  properties: { environment: environment }\n}\n\n${containers}`;
  const receipt = {
    kind: "local-scratch-simulation",
    target: RADIUS_TARGET,
    revision: expectedRevision,
    requirements: validation.requirements,
    changes: plan.changes.map(({ id, kind }) => ({ id, kind })),
    simulatedResources: plan.definition.proposed,
    nativeCompilation: "not_run",
    environmentDeployment: "held",
    externalEffects: false,
  };
  return freeze({
    "app.bicep": bicep,
    "requirements.json": JSON.stringify(plan.definition.requirements, null, 2) + "\n",
    "infra-change.json": JSON.stringify(plan.changes, null, 2) + "\n",
    "deployment-simulation.json": JSON.stringify(receipt, null, 2) + "\n",
  });
}

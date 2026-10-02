// CONTRACTS.md §6 (environment, deployment, promotion). Plain JavaScript for the same reason as decision-rules.mjs:
// the controller (src/control, plain .mjs) must run these checks itself; environment.ts wraps them for the plugin.
// Nothing here runs a script, reads a file or touches a host.
import { parseRef, noPersonal } from "./refs.mjs";

export const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LIMITS = Object.freeze({
  label: 40,
  targetLabel: 80,
  site: 253,
  hostId: 64,
  requirements: 32,
  requirementLabel: 120,
  args: 8,
  arg: 120,
  checkTimeout: 600,
  stepTimeout: 3600,
  detail: 300,
  impact: 8,
  readiness: 32,
  rollbackPlan: 600,
  log: 200,
  logLine: 300,
  deploymentNote: 300,
  tag: 64,
});
export const ENVIRONMENT_STATES = Object.freeze(["active", "retired"]);
export const PROMOTION_STATES = Object.freeze([
  "proposed",
  "awaiting-approval",
  "approved",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "rolling-back",
  "rolled-back",
  "cancelled",
]);
export const DEPLOYMENT_STATUS = Object.freeze(["succeeded", "failed", "rolled-back", "unknown"]);
export const STEP_NAMES = Object.freeze(["deploy", "verify", "rollback"]);
// Terminal promotion states: nothing runs or changes after these.
export const FINISHED = Object.freeze(["succeeded", "failed", "rolled-back", "cancelled"]);

export class EnvironmentRefused extends Error {}
const refuse = (message) => {
  throw new EnvironmentRefused(message);
};
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v, keys, where) => {
  if (!plainObject(v)) refuse(`${where} must be an object`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length) refuse(`${where} has unknown fields: ${extra.join(", ")}`);
};
const text = (v, max, where, { empty = false } = {}) => {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim()))
    refuse(`${where} must be text of at most ${max} characters`);
  if (!noPersonal(v)) refuse(`${where} contains a personal path, host name, email or token`);
  return v;
};
const int = (v, min, max, where) => {
  if (!Number.isInteger(v) || v < min || v > max)
    refuse(`${where} must be a whole number from ${min} to ${max}`);
  return v;
};

// §6.2 #1: a repo-relative file. No leading slash, no "." or ".." segment, no backslash, no home shorthand, no
// control characters. The runner checks again, against the real checkout, that it resolves inside it.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export function relpath(v, where = "script") {
  if (typeof v !== "string" || !v || v.length > 255)
    refuse(`${where} must be a file path inside the repository`);
  if (v.startsWith("/") || v.includes("\\") || v.startsWith("~"))
    refuse(`${where} must be relative to the repository, not an absolute path`);
  const parts = v.split("/");
  if (parts.some((p) => p === "." || p === "..")) refuse(`${where} may not leave the repository`);
  if (!parts.every((p) => SEGMENT.test(p)))
    refuse(`${where} must be a plain file path inside the repository`);
  return v;
}
const args = (v, where) => {
  if (!Array.isArray(v) || v.length > LIMITS.args)
    refuse(`${where} must be a list of at most ${LIMITS.args} arguments`);
  return v.map((a, i) => text(a, LIMITS.arg, `${where}[${i}]`, { empty: true }));
};
export function step(v, where) {
  exactKeys(v, ["script", "args", "timeoutS", "destructive"], where);
  if (typeof v.destructive !== "boolean") refuse(`${where}.destructive must be true or false`);
  return {
    script: relpath(v.script, `${where}.script`),
    args: args(v.args, `${where}.args`),
    timeoutS: int(v.timeoutS, 1, LIMITS.stepTimeout, `${where}.timeoutS`),
    destructive: v.destructive,
  };
}
function check(v, where) {
  if (!plainObject(v)) refuse(`${where} must be an object`);
  if (v.kind === "manual") {
    exactKeys(v, ["kind"], where);
    return { kind: "manual" };
  }
  if (v.kind !== "script") refuse(`${where}.kind must be script or manual`);
  exactKeys(v, ["kind", "script", "args", "timeoutS"], where);
  return {
    kind: "script",
    script: relpath(v.script, `${where}.script`),
    args: args(v.args, `${where}.args`),
    timeoutS: int(v.timeoutS, 1, LIMITS.checkTimeout, `${where}.timeoutS`),
  };
}
function target(v) {
  if (!plainObject(v)) refuse("target must be an object");
  if (v.kind === "fulcra-host") {
    exactKeys(v, ["kind", "hostId"], "target");
    if (typeof v.hostId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.hostId))
      refuse("target.hostId must be a Fulcra host id");
    return { kind: "fulcra-host", hostId: v.hostId };
  }
  if (v.kind !== "external") refuse("target.kind must be fulcra-host or external");
  exactKeys(v, ["kind", "label", "site"], "target");
  const site =
    v.site === null
      ? null
      : typeof v.site === "string" &&
          v.site.length <= LIMITS.site &&
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
            v.site,
          ) &&
          noPersonal(v.site)
        ? v.site
        : refuse("target.site must be a public host name or null");
  return { kind: "external", label: text(v.label, LIMITS.targetLabel, "target.label"), site };
}
export const repoKey = (v) =>
  typeof v === "string" && parseRef(`repo:${v}`)?.kind === "repo" && noPersonal(v)
    ? v
    : refuse("repo must be a repository key such as github:acme/app");

/**
 * What a proposer may send: the definition without the server's fields (§1: ids and revisions are the server's;
 * `last` is written only by readiness checks). Returns the normalized definition, in contract key order.
 */
export const DEFINITION_KEYS = Object.freeze([
  "key",
  "label",
  "order",
  "target",
  "repo",
  "requirements",
  "steps",
  "state",
]);
export function validateDefinition(d) {
  exactKeys(d, DEFINITION_KEYS, "environment");
  if (typeof d.key !== "string" || !KEY.test(d.key))
    refuse("key must be a short lowercase name such as next");
  if (!Array.isArray(d.requirements) || d.requirements.length > LIMITS.requirements)
    refuse(`requirements must be a list of at most ${LIMITS.requirements}`);
  const requirements = d.requirements.map((r, i) => {
    exactKeys(r, ["id", "label", "check"], `requirements[${i}]`);
    if (typeof r.id !== "string" || !KEY.test(r.id))
      refuse(`requirements[${i}].id must be a short lowercase name`);
    return {
      id: r.id,
      label: text(r.label, LIMITS.requirementLabel, `requirements[${i}].label`),
      check: check(r.check, `requirements[${i}].check`),
    };
  });
  if (new Set(requirements.map((r) => r.id)).size !== requirements.length)
    refuse("requirement ids must be unique");
  exactKeys(d.steps, STEP_NAMES, "steps");
  if (!ENVIRONMENT_STATES.includes(d.state)) refuse("state must be active or retired");
  return {
    key: d.key,
    label: text(d.label, LIMITS.label, "label"),
    order: int(d.order, 0, 9, "order"),
    target: target(d.target),
    repo: repoKey(d.repo),
    requirements,
    steps: {
      deploy: step(d.steps.deploy, "steps.deploy"),
      verify: step(d.steps.verify, "steps.verify"),
      rollback: step(d.steps.rollback, "steps.rollback"),
    },
    state: d.state,
  };
}
/**
 * §6.2 #5 and v1.15 §6.1 (J8-1): is `after` the definition already in force? Every approved field counts: key, label,
 * order and target (what the approval card names), repo, requirements, steps and definitionCommit (what runs), and
 * state (a retired environment changes which step comes next). Anything else is a change that needs an `environment-change` approval.
 */
export function sameDefinition(before, after) {
  if (!before) return false;
  const approved = (def) => JSON.stringify(definitionBound(null, null, def));
  return approved(before) === approved(after);
}
/** Plain words for what a change does, for the approval card. */
export function definitionChanges(before, after) {
  if (!before) return [];
  const same = (f) => JSON.stringify(f(before)) === JSON.stringify(f(after));
  const scripts = (def) => [def.steps, def.requirements.map((r) => [r.id, r.label, r.check])];
  return [
    before.key !== after.key || before.label !== after.label
      ? `renames ${before.label} to ${after.label}`
      : null,
    before.order !== after.order
      ? `moves it from place ${before.order} to place ${after.order} in the path`
      : null,
    same((d) => d.target) ? null : "changes where it runs",
    before.repo !== after.repo ? "changes the repository its steps come from" : null,
    same(scripts) ? null : "changes the steps or setup checks Fulcra runs",
    before.repo === after.repo && before.definitionCommit !== after.definitionCommit
      ? "takes its scripts from a newer version of the repository"
      : null,
    before.state !== after.state
      ? after.state === "retired"
        ? "retires it"
        : "brings it back into use"
      : null,
  ].filter(Boolean);
}
/**
 * The bound object of an environment-change approval: the new definition, without run results, and (v1.15 §6.2 #1,
 * J8-4) `definitionCommit`, the version of the repository whose scripts it will run, so the approval covers what the
 * scripts say, not only their names.
 */
export const definitionBound = (id, projectId, def) => ({
  id,
  projectId,
  key: def.key,
  label: def.label,
  order: def.order,
  target: def.target,
  repo: def.repo,
  requirements: def.requirements.map((r) => ({ id: r.id, label: r.label, check: r.check })),
  steps: def.steps,
  state: def.state,
  definitionCommit: def.definitionCommit ?? null,
});
/** §6.1: a promotion's digest is the canonical JSON of exactly these fields. */
export const promotionBound = ({ from, to, commit, readiness }, toSteps) => ({
  from,
  to,
  commit,
  steps: toSteps,
  readiness,
});
/** §6.2 #3 and §3.2 #3: any destructive step makes the approval option destructive. */
export const destructiveSteps = (steps) => STEP_NAMES.filter((n) => steps[n].destructive);
/** A commit ref for this environment's repository, or a refusal. */
export function commitRef(v, repo) {
  const r = parseRef(v);
  if (r?.kind !== "commit") refuse("commit must be a commit ref with the full 40-character id");
  if (r.repoKey !== repo) refuse("That commit is not in this environment's repository");
  return { ref: v, sha: r.sha };
}

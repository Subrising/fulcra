// Fictional Environments data for the J8 UI test and screenshots. Every name, id and version is invented; nothing
// refers to a real installation or host. The shape is exactly organization.environments' output (checked in the test).
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
export const PROJECT = uuid(20),
  DEV = uuid(41),
  NEXT = uuid(42),
  PROD = uuid(43),
  PROMOTION = uuid(60),
  DECISION = uuid(61);
export const REPO = "github:acme/tally";
const sha = (c) => c.repeat(40).slice(0, 40);
export const V1 = `commit:${REPO}@${sha("3a")}`,
  V2 = `commit:${REPO}@${sha("7c")}`;
const step = (script) => ({ script, args: [], timeoutS: 300, destructive: false });
const steps = {
  deploy: step("scripts/deploy.sh"),
  verify: step("scripts/verify.sh"),
  rollback: step("scripts/rollback.sh"),
};
const requirement = (id, label, state, minutes) => ({
  id,
  label,
  check: { kind: "script", script: `checks/${id}.sh`, args: [], timeoutS: 60 },
  last: { state, at: minutes == null ? null : at(minutes), detail: "" },
});
const env = (id, key, label, order, requirements) => ({
  version: 1,
  id,
  revision: 3,
  projectId: PROJECT,
  key,
  label,
  order,
  target: { kind: "fulcra-host", hostId: "host-demo" },
  repo: REPO,
  requirements,
  steps,
  state: "active",
  definitionCommit: V1,
});
const deployment = (
  environmentId,
  commit,
  minutes,
  status = "succeeded",
  note = "Now in place",
) => ({
  id: uuid(70 + minutes),
  environmentId,
  version: { commit, tag: null },
  at: at(minutes),
  by: "human",
  promotionId: null,
  status,
  note,
});
export const environments = [
  {
    id: DEV,
    key: "dev",
    order: 0,
    environment: env(DEV, "dev", "Dev", 0, [
      requirement("tests", "The automated tests pass", "pass", 30),
    ]),
    pending: null,
    current: deployment(DEV, V2, 40),
    latest: deployment(DEV, V2, 40),
    health: "good",
    meaning: "the working copy the team builds on",
  },
  {
    id: NEXT,
    key: "next",
    order: 1,
    environment: env(NEXT, "next", "Next", 1, [
      requirement("answers", "The practice site answers", "pass", 12),
      requirement("data", "Practice data is in place", "pass", 12),
      requirement("sign-in", "Sign-in works", "unknown", null),
    ]),
    pending: null,
    current: deployment(NEXT, V1, 1440),
    latest: deployment(NEXT, V1, 1440),
    health: "good",
    meaning: "the practice copy customers don't see yet",
  },
  {
    id: PROD,
    key: "prod",
    order: 2,
    environment: env(PROD, "prod", "Live", 2, [
      requirement("backup", "Last night's backup finished", "pass", 300),
      requirement("capacity", "There is room for the new version", "fail", 300),
    ]),
    pending: null,
    current: deployment(PROD, V1, 4320),
    latest: deployment(PROD, V1, 4320),
    health: "attention",
    meaning: "the live version customers use",
  },
];
export const awaiting = {
  promotion: {
    version: 1,
    id: PROMOTION,
    revision: 3,
    projectId: PROJECT,
    from: DEV,
    to: NEXT,
    commit: V2,
    impact: [V2],
    readiness: [
      { requirementId: "answers", state: "pass" },
      { requirementId: "data", state: "pass" },
      { requirementId: "sign-in", state: "unknown" },
    ],
    rollbackPlan:
      "If deploying or checking Next fails, Fulcra runs its undo step straight away and records what happened. Nothing else is changed.",
    decisionId: DECISION,
    state: "awaiting-approval",
    log: [{ at: at(2), step: "verify", line: "Setup checks finished" }],
    digest: "ab".repeat(32),
  },
  preparing: false,
  askedVia: "role",
  changes: {
    from: V1,
    files: 4,
    sample: ["src/chart.ts", "src/week-view.ts", "src/streaks.ts", "README.md"],
  },
};
export const view = (extra = {}) => ({
  version: 1,
  observedAt: at(0),
  partial: false,
  stale: false,
  error: null,
  projectId: PROJECT,
  environments,
  promotions: [awaiting],
  ...extra,
});
export const projects = () => ({
  observedAt: at(0),
  available: true,
  partial: false,
  note: "",
  projects: [
    { id: PROJECT, name: "Tally", description: "A small habit tracker.", status: "in_progress" },
  ],
  membership: [],
});

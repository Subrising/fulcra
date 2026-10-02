import fs from "node:fs";
import { connect, root, runtime, verifyPins } from "./runtime.mjs";
verifyPins();
const workerId = process.env.ORCA_REVISION_WORKER_ID;
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workerId ?? ""))
  throw Error("Set ORCA_REVISION_WORKER_ID");
const reviewerId = process.env.ORCA_REVISION_REVIEWER_ID;
if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reviewerId ?? ""))
  throw Error("Set ORCA_REVISION_REVIEWER_ID");
const journalPath = `${runtime.home}/permission-journal.jsonl`;
const decisions = new Map();
// Exact input identity: order-independent object keys, array order preserved.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const identityFor = (request) => {
  if (
    typeof request.id !== "string" ||
    !request.id ||
    typeof request.name !== "string" ||
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  )
    throw new Error("Invalid permission identity");
  return JSON.stringify([
    runtime.marker,
    workerId,
    request.id,
    request.name,
    canonical(request.input),
  ]);
};
const keyFor = (identity) => {
  const parts = JSON.parse(identity);
  if (
    !Array.isArray(parts) ||
    parts.length !== 5 ||
    parts.slice(0, 4).some((x) => typeof x !== "string" || !x) ||
    !parts[4] ||
    typeof parts[4] !== "object" ||
    Array.isArray(parts[4])
  )
    throw new Error("Invalid journal identity");
  return JSON.stringify(parts.slice(0, 3));
};
if (fs.existsSync(journalPath)) {
  const text = fs.readFileSync(journalPath, "utf8");
  if (text && !text.endsWith("\n"))
    throw new Error("Uncertain truncated permission journal; reconcile before restart");
  for (const line of text.split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (
      entry.version !== 1 ||
      !["intent", "delivered"].includes(entry.state) ||
      typeof entry.identity !== "string"
    )
      throw new Error("Invalid permission journal");
    const key = keyFor(entry.identity),
      previous = decisions.get(key);
    if (
      (previous && previous.identity !== entry.identity) ||
      (entry.state === "delivered" && previous?.state !== "intent") ||
      (entry.state === "intent" && previous)
    )
      throw new Error("Conflicting permission journal; reconcile before restart");
    decisions.set(key, entry);
  }
} else {
  const legacy = `${runtime.home}/revision-events.jsonl`;
  if (
    fs.existsSync(legacy) &&
    fs
      .readFileSync(legacy, "utf8")
      .split("\n")
      .filter(Boolean)
      .some((line) =>
        ["permission-attempt", "permission-delivered"].includes(JSON.parse(line).type),
      )
  ) {
    throw new Error("Legacy permission history requires explicit reconciliation before restart");
  }
}
for (const entry of decisions.values()) {
  const [marker, owner] = JSON.parse(entry.identity);
  if (marker === runtime.marker && owner === workerId && entry.state === "intent")
    throw new Error("Uncertain prior permission intent; reconcile delivery before retry");
}
const persist = (identity, state) => {
  const entry = { version: 1, identity, state, at: new Date().toISOString() };
  fs.mkdirSync(`${root}runtime`, { recursive: true });
  const parent = fs.openSync(root, "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  // Flush the append and directory before taking the external action. A failed
  // delivery/flush leaves an explicit uncertain intent, never a blind retry.
  fs.appendFileSync(journalPath, JSON.stringify(entry) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flush: true,
  });
  const directory = fs.openSync(`${root}runtime`, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  decisions.set(keyFor(identity), entry);
};
const client = await connect();
const worker = client.agents.ref(workerId);
const reviewer = client.agents.ref(reviewerId);
const allowed = new Set(
  ["leadership-brief.md", "review-checklist.md"].map(
    (n) => `${runtime.installation}/tasks/claude/${n}`,
  ),
);
const seen = new Set();
let started = false,
  duplicateEvents = 0;
const record = (event) =>
  fs.appendFileSync(
    `${runtime.home}/revision-events.jsonl`,
    JSON.stringify({
      at: new Date().toISOString(),
      controller: "orca-revision-controller",
      ...event,
    }) + "\n",
  );
let finish, fail;
const completion = new Promise((resolve, reject) => {
  finish = resolve;
  fail = reject;
});
// Observe rejection immediately, even while send/setup is still awaited.
completion.catch(() => {});
const timer = setTimeout(
  () => fail(new Error("Worker did not finish within three minutes")),
  180000,
);
async function handle(update) {
  if (update.kind !== "upsert") return;
  const agent = update.agent;
  if (agent.lastError) throw new Error(agent.lastError);
  if (agent.status === "running") started = true;
  for (const request of agent.pendingPermissions) {
    if (!["Write", "Edit"].includes(request.name) || !allowed.has(request.input?.file_path)) {
      record({ type: "unhandled-permission", request });
      continue;
    }
    const identity = identityFor(request),
      previous = decisions.get(keyFor(identity));
    if (previous) {
      if (previous.identity !== identity)
        throw new Error("Permission identity changed for an existing request");
      if (previous.state === "delivered") {
        duplicateEvents++;
        continue;
      }
      record({ type: "permission-uncertain", identity });
      throw new Error("Uncertain prior permission intent; reconcile delivery before retry");
    }
    persist(identity, "intent");
    seen.add(request.id);
    await worker.respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
    persist(identity, "delivered");
  }
  if (started && agent.status === "idle") finish(agent);
}
let unsubscribe = () => {},
  timeline = () => {};
let queue = Promise.resolve();
const enqueue = (update) => {
  queue = queue.then(() => handle(update));
  queue.catch(fail);
};
try {
  unsubscribe = worker.subscribe((u) => {
    enqueue(u);
    if (process.env.ORCA_REPLAY_NOTIFICATIONS === "1") enqueue(u);
  });
  timeline = worker.timeline.subscribe((e) => record({ type: "worker-event", ...e }));
  await timeline.ready;
  await client.agents.list({ subscribe: { subscriptionId: "orca-revision-controller" } });
  record({ type: "assignment" });
  await worker.send(
    "Revise the saved leadership-brief.md in this same session: replace the delegated example with changing the fictional app button label from Save to Save plan, and add a one-sentence acceptance check. First reread the shared policy with the added memory tool. Use Write to overwrite the complete brief, then use a second Write call to create review-checklist.md with three concise reviewer checks. These two exact file writes are delegated to the controller; do not avoid the prompts using Bash. Keep the codename out of files and all examples synthetic. Finish with paths and evidence. Do not contact anyone or run onboarding.",
  );
  const result = await completion;
  record({
    type: "worker-completed",
    nativeSession: result.persistence?.sessionId,
    permissions: [...seen],
    duplicateEvents,
  });
  record({ type: "reviewer-wake", cause: "worker-idle-event", reviewer: reviewer.id });
  const review = await reviewer.run(
    `Review the revised peer artifact ${runtime.installation}/tasks/claude/leadership-brief.md and review-checklist.md. Check source fidelity using shared_memory_read on the policy source cited in the artifact, synthetic examples only, correct separation of major decisions vs routine delegated work, new Save plan example and meaningful acceptance check. Write peer-review.md in your OWN task directory with ACCEPT or concrete defects and reasons. Do not modify the peer artifacts, contact sessions, browse or run onboarding.`,
    { timeoutMs: 180000 },
  );
  record({ type: "reviewer-result", result: review });
  console.log(JSON.stringify({ permissions: [...seen], duplicateEvents, review }, null, 2));
} finally {
  clearTimeout(timer);
  unsubscribe();
  timeline();
  await client.close();
}

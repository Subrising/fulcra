import { portable, localTasks } from "../portable-config.mjs";
export const COMPANY = portable.authority.companyId;
export const PROGRAMME = portable.authority.programmeId;
export const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export async function readIssue(id, fetcher = fetch) {
  if (!uuid(id)) throw new Error("Invalid task ID");
  if (portable.authority.issueApi === null) {
    const issue = localTasks().find((r) => r.id === id);
    if (!issue || issue.companyId !== COMPANY) throw Error("Local task unavailable");
    return issue;
  }
  const response = await fetcher(`${portable.authority.issueApi}/api/issues/${id}`, {
    redirect: "error",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok || !response.body) throw new Error("Task authority unavailable");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 131072) throw new Error("Task response exceeds bound");
    chunks.push(chunk);
  }
  const issue = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (issue.id !== id || issue.companyId !== COMPANY)
    throw new Error("Task authority identity mismatch");
  return issue;
}
export const authorityKey = (issue) =>
  JSON.stringify(
    issue.delegationAuthority ?? [
      issue.id,
      issue.companyId,
      issue.parentId ?? null,
      issue.assigneeUserId,
      issue.assigneeAgentId ?? null,
      issue.status,
    ],
  );
async function walk(id, read, signal) {
  const seen = new Set(),
    tuples = [];
  let current = id,
    selected;
  for (let n = 0; n < 8; n++) {
    if (!uuid(current) || seen.has(current)) throw new Error("Invalid task ancestry");
    signal.throwIfAborted();
    seen.add(current);
    const issue = await read(current);
    signal.throwIfAborted();
    selected ??= issue;
    tuples.push(JSON.parse(authorityKey(issue)));
    if (
      issue.id !== current ||
      issue.companyId !== COMPANY ||
      issue.assigneeUserId !== "local-board" ||
      issue.assigneeAgentId ||
      !["todo", "in_progress"].includes(issue.status)
    )
      throw new Error("Task is outside delegated authority");
    if (current === PROGRAMME) return { ...selected, delegationAuthority: tuples };
    current = issue.parentId;
  }
  throw new Error("Task is not in the configured programme ancestry");
}

export async function authorizeTask(id, read) {
  const signal = AbortSignal.timeout(4000);
  const reader =
    read ?? ((key) => readIssue(key, (url, options) => fetch(url, { ...options, signal })));
  return await Promise.race([
    walk(id, reader, signal),
    new Promise((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("Task authority deadline exceeded")),
        { once: true },
      ),
    ),
  ]);
}

// A definite, recorded change of the authority behind queued or pending work -- as opposed to an unknown
// or transient error. The distinction decides whether work is cancelled or retried, so it is a type rather
// than a message: quota-runtime cancels a queued instruction on it and retries otherwise, and the channel
// pump must make the same distinction or a momentary failure permanently kills an approved message.
export class SourceChanged extends Error {}

// The opposite fact, and the other half of the same decision: a recipient that cannot take input RIGHT
// NOW -- mid-turn, or holding a permission prompt. It says nothing about authority. The same message
// identity can be re-offered when the seat next goes idle, spending no further allowance and replaying
// nothing. A type rather than a message because two independent pumps defer on it, and both used to
// re-derive it by matching the error TEXT -- so rewording a controller refusal would silently have
// turned every deferral into a permanent failure.
export class RecipientBusy extends Error {}

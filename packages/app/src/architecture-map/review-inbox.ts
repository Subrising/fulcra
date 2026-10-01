import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PullRequestReviewDecisionKind } from "@getpaseo/protocol/messages";
import { resolveOrganizationPluginId } from "@/sessions/session-ownership-store";

/**
 * G4: the review decision is also recorded in the Inbox when the host offers it (the organization plugin's
 * `organization.review-record`, a record-only item: "You reviewed PR #N: <choice> — <note>"). The host file the review
 * screen already writes stays the record of the decision and the fallback: a host without the method, a missing
 * plugin, a refusal or a failure leaves it exactly as before. Nothing here reaches GitHub.
 */
export const REVIEW_RECORD_RPC = "organization.review-record";
export type InboxRecordResult = "recorded" | "already" | "refused" | "unavailable";
type Invoker = Pick<DaemonClient, "invokePluginRpc">;
export interface ReviewRecord {
  workspace: string;
  url: string | undefined;
  pullRequest: number;
  headOid: string;
  decision: PullRequestReviewDecisionKind;
  note: string;
}

/** "owner/name" from a GitHub pull request URL, or null when it is not one. */
export function repoFromPullRequestUrl(url: string | undefined): string | null {
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/\d+(?:[/?#].*)?$/.exec(
      url ?? "",
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function recordReviewWith(
  client: Invoker | null,
  pluginId: string | null,
  r: ReviewRecord,
): Promise<InboxRecordResult> {
  const repo = repoFromPullRequestUrl(r.url);
  if (!client || !pluginId || !repo || !/^[0-9a-f]{40}$/.test(r.headOid) || r.pullRequest < 1)
    return "unavailable";
  try {
    const out = (await client.invokePluginRpc(pluginId, REVIEW_RECORD_RPC, {
      workspace: r.workspace,
      repo,
      number: r.pullRequest,
      headSha: r.headOid,
      choice: r.decision,
      note: r.note.trim(),
      via: "app-mac",
    })) as { ok?: unknown; already?: unknown } | null;
    if (!out || out.ok !== true) return "refused";
    return out.already === true ? "already" : "recorded";
  } catch {
    // A host whose organization plugin predates the method answers "unknown method": the host file is the record.
    return "unavailable";
  }
}

export function recordReviewInInbox(
  client: Invoker | null,
  serverId: string,
  r: ReviewRecord,
): Promise<InboxRecordResult> {
  return recordReviewWith(client, resolveOrganizationPluginId(serverId), r);
}

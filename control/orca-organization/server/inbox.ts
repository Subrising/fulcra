// Fulcra J3 Inbox, server side. Every handler is a thin, typed view over the controller's operator methods
// (src/control/decisions.mjs, role-channels.mjs): the controller is the only authority and re-checks every
// rule. This file adds three things only:
//   - the read-only legacy adapter: a published outcome record that still needs a decision (§3.3);
//   - the last good inbox, returned `stale` when the controller does not answer (CONTRACTS §1 Observation);
//   - per-item validation, so one malformed record drops out instead of blanking the whole list.
import fs from "node:fs";
import {
  inboxItem,
  inboxRpc,
  decisionRpc,
  decisionChooseRpc,
  reviewRecordRpc,
  heldMessage,
  heldMessageRpc,
  heldReadRpc,
  heldReplyRpc,
  heldReleaseRpc,
  digestBody,
  digestRpc,
  decisionPacket,
  type InboxItem,
} from "../shared/cc/decision";
import { parseRef } from "../shared/cc/refs.mjs";
import type { ContractInput, ContractOutput } from "../shared/rpc-contract";
type Call = (method: string, input?: unknown) => Promise<any>;
interface OutcomeSource {
  list(): string[];
  read(taskId: string): {
    record: {
      title: string;
      publishedAt?: string;
      coordination?: { decisionNeeded: string | null; affectedProjects: { projectId: string }[] };
      decision: unknown;
    };
  };
}
export const LEGACY_CHECKS = 12;
const OUTCOME_FILE =
  /^orca-outcome-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const message = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 500);
// The published-outcome directory, bounded: at most 64 records are considered.
// The root is resolved per read (J0's installationPath): an unconfigured installation lists nothing.
export function outcomeDirectory(
  root: string | (() => string),
  read: (taskId: string, root: string) => any,
): OutcomeSource {
  const resolve = () => (typeof root === "function" ? root() : root);
  return {
    list: () => {
      try {
        return fs
          .readdirSync(resolve())
          .map((n) => OUTCOME_FILE.exec(n)?.[1])
          .filter((v): v is string => !!v)
          .sort()
          .slice(0, 64);
      } catch {
        return [];
      }
    },
    read: (taskId) => read(taskId, resolve()),
  };
}
export function createInbox({
  call,
  outcomes,
  allowed = async () => true,
  now = () => new Date().toISOString(),
}: {
  call: Call;
  outcomes?: OutcomeSource;
  allowed?: (taskId: string) => Promise<boolean>;
  now?: () => string;
}) {
  let last: ContractOutput<typeof inboxRpc> | null = null;
  // §3.3 legacy adapter. Read-only: nothing here can choose; the card says "Answer in the conversation".
  // Each allowed() check costs controller calls (task-authority + list) out of the invocation's 32 (L37): the local
  // record is read first, authority is checked only for records that still need a decision, and at most LEGACY_CHECKS
  // of them; beyond that the list is marked partial instead of silently losing records to an exhausted budget.
  let legacyTruncated = false;
  async function legacy(observedAt: string): Promise<InboxItem[]> {
    legacyTruncated = false;
    if (!outcomes) return [];
    const items: InboxItem[] = [];
    let checks = 0;
    for (const taskId of outcomes.list()) {
      try {
        const { record } = outcomes.read(taskId),
          needed = record.coordination?.decisionNeeded;
        if (!needed || record.decision !== null) continue;
        if (checks >= LEGACY_CHECKS) {
          legacyTruncated = true;
          continue;
        }
        checks++;
        if (!(await allowed(taskId))) continue;
        items.push({
          key: `outcome-${taskId}`,
          source: "outcome",
          ref: `outcome:${taskId}`,
          title: clip(record.title, 120),
          summary: clip(needed, 280),
          projectId: record.coordination?.affectedProjects[0]?.projectId ?? null,
          urgency: "today",
          createdAt: record.publishedAt ?? observedAt,
          unread: true,
        });
      } catch {
        /* an unreadable record is simply not listed; the Outcomes view reports it */
      }
    }
    return items;
  }
  const valid = (items: unknown[]) =>
    items.flatMap((i) => {
      const r = inboxItem.safeParse(i);
      return r.success ? [r.data] : [];
    });
  return {
    async inbox(): Promise<ContractOutput<typeof inboxRpc>> {
      const observedAt = now();
      try {
        const d = await call("decisions-inbox", null),
          extra = await legacy(observedAt);
        const controller = valid(d.items),
          adapted = valid(extra),
          items = [...controller, ...adapted].slice(0, 200);
        const rank = { now: 0, today: 1, fyi: 2 } as const;
        items.sort(
          (a, b) => rank[a.urgency] - rank[b.urgency] || b.createdAt.localeCompare(a.createdAt),
        );
        const n = (f: (i: InboxItem) => boolean) => items.filter(f).length;
        const counts = {
          now: n((i) => i.urgency === "now"),
          today: n((i) => i.urgency === "today"),
          fyi: n((i) => i.urgency === "fyi"),
          decisions: n(
            (i) =>
              (i.source === "decision" && !i.key.startsWith("approval-")) || i.source === "outcome",
          ),
          approvals: n((i) => i.key.startsWith("approval-")),
          held: n((i) => i.source === "held"),
          digests: n((i) => i.source === "digest"),
          total: items.length,
        };
        last = inboxRpc.output.parse({
          version: 1,
          observedAt: d.observedAt,
          partial:
            d.partial ||
            controller.length !== d.items.length ||
            adapted.length !== extra.length ||
            legacyTruncated,
          stale: false,
          error: null,
          items,
          counts,
          ...(d.unreadable || adapted.length !== extra.length || legacyTruncated
            ? {
                unreadable: {
                  ...pickUnreadable(d.unreadable),
                  ...(adapted.length !== extra.length || legacyTruncated
                    ? { outcomes: Math.max(1, extra.length - adapted.length) }
                    : {}),
                },
              }
            : {}),
        });
        return last;
      } catch (e) {
        // Never an empty screen for a stall: the last good list, marked stale, with its own observedAt.
        if (last) return { ...last, stale: true, error: message(e) };
        return {
          version: 1,
          observedAt,
          partial: true,
          stale: true,
          error: message(e),
          items: [],
          counts: {
            now: 0,
            today: 0,
            fyi: 0,
            decisions: 0,
            approvals: 0,
            held: 0,
            digests: 0,
            total: 0,
          },
        };
      }
    },
    async decision(
      input: ContractInput<typeof decisionRpc>,
    ): Promise<ContractOutput<typeof decisionRpc>> {
      const observedAt = now();
      try {
        const d = await call("decisions-get", { id: input.id }),
          packet = decisionPacket.parse(d.decision);
        return {
          version: 1,
          observedAt,
          partial: false,
          stale: false,
          error: null,
          decision: packet,
          answered: d.answered ?? null,
          evidence: packet.evidence.map((e) => ({
            ref: e.ref,
            label: e.label,
            kind: parseRef(e.ref)?.kind ?? "unknown",
          })),
        };
      } catch (e) {
        return {
          version: 1,
          observedAt,
          partial: true,
          stale: true,
          error: message(e),
          decision: null,
          answered: null,
          evidence: [],
        };
      }
    },
    async choose(
      input: ContractInput<typeof decisionChooseRpc>,
    ): Promise<ContractOutput<typeof decisionChooseRpc>> {
      const observedAt = now();
      let d: any;
      try {
        d = await call("decisions-choose", input);
      } catch (e) {
        // A refusal is an answer, not a failure: "Changed since you looked; refresh", "Already answered on …".
        return { ok: false, message: message(e), observedAt, decision: null };
      }
      // R-J3-6: the controller recorded the choice, so this is ok whatever the display parse says; the card refetches.
      const shown = decisionPacket.safeParse(d?.decision);
      return { ok: true, message: null, observedAt, decision: shown.success ? shown.data : null };
    },
    // G4: record the review screen's decision in the Inbox. A refusal is an answer (bad input, full store), not a failure.
    async recordReview(
      input: ContractInput<typeof reviewRecordRpc>,
    ): Promise<ContractOutput<typeof reviewRecordRpc>> {
      const observedAt = now();
      let d: any;
      try {
        d = await call("decisions-record-review", input);
      } catch (e) {
        return { ok: false, message: message(e), observedAt, decisionId: null, already: false };
      }
      const decisionId =
        typeof d?.decision?.id === "string" && /^[0-9a-f-]{36}$/.test(d.decision.id)
          ? d.decision.id
          : null;
      return { ok: true, message: null, observedAt, decisionId, already: d?.resend === true };
    },
    async held(
      input: ContractInput<typeof heldMessageRpc>,
    ): Promise<ContractOutput<typeof heldMessageRpc>> {
      const observedAt = now();
      try {
        return {
          version: 1,
          observedAt,
          partial: false,
          stale: false,
          error: null,
          message: heldMessage.parse(await call("decisions-held-message", input)),
        };
      } catch (e) {
        return {
          version: 1,
          observedAt,
          partial: true,
          stale: true,
          error: message(e),
          message: null,
        };
      }
    },
    async heldRead(
      input: ContractInput<typeof heldReadRpc>,
    ): Promise<ContractOutput<typeof heldReadRpc>> {
      const observedAt = now();
      try {
        await call("seat-receipt", { ...input, note: "Read in Fulcra Inbox" });
        return { ok: true, message: null, observedAt };
      } catch (e) {
        return { ok: false, message: message(e), observedAt };
      }
    },
    async heldReply(
      input: ContractInput<typeof heldReplyRpc>,
    ): Promise<ContractOutput<typeof heldReplyRpc>> {
      const observedAt = now();
      try {
        const r = await call("seat-reply", input);
        return {
          ok: true,
          message: null,
          observedAt,
          state: String(r.state ?? "unknown").slice(0, 40),
        };
      } catch (e) {
        return { ok: false, message: message(e), observedAt, state: null };
      }
    },
    // The seat is read from the held message itself, never from input, and release needs the seat's current
    // hold revision: the operator may release only what is actually held now.
    async heldRelease(
      input: ContractInput<typeof heldReleaseRpc>,
    ): Promise<ContractOutput<typeof heldReleaseRpc>> {
      const observedAt = now();
      try {
        const m = heldMessage.parse(
          await call("decisions-held-message", {
            channelId: input.channelId,
            messageId: input.messageId,
          }),
        );
        if (!m.canRelease) throw new Error("This role is no longer held for you");
        await call("seat-unhold", {
          role: "prime",
          seat: m.toSeat,
          expectedRevision: input.expectedSeatRevision,
          note: "Released from the Fulcra inbox by the operator",
        });
        return { ok: true, message: null, observedAt };
      } catch (e) {
        return { ok: false, message: message(e), observedAt };
      }
    },
    async digest(
      input: ContractInput<typeof digestRpc>,
    ): Promise<ContractOutput<typeof digestRpc>> {
      const observedAt = now();
      try {
        const d = await call("decisions-digest", input);
        return {
          version: 1,
          observedAt,
          partial: false,
          stale: false,
          error: null,
          digest: digestBody.parse(d.digest),
        };
      } catch (e) {
        return {
          version: 1,
          observedAt,
          partial: true,
          stale: true,
          error: message(e),
          digest: null,
        };
      }
    },
  };
}
// U5-D01: the controller's per-section skip counts, only for the sections the app knows how to name.
const INBOX_SECTIONS = ["decisions", "held", "digests", "devices", "attention"] as const;
function pickUnreadable(u: unknown): Partial<Record<(typeof INBOX_SECTIONS)[number], number>> {
  if (!u || typeof u !== "object") return {};
  return Object.fromEntries(
    INBOX_SECTIONS.flatMap((k) => {
      const v = (u as Record<string, unknown>)[k];
      return Number.isInteger(v) && (v as number) >= 0 ? [[k, v as number]] : [];
    }),
  );
}

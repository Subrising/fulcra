import test from "node:test";
import assert from "node:assert/strict";
import { inboxHeadline, humanInboxItems, type InboxData } from "./inbox-model";

const ALL_CLEAR = "Nothing is waiting for you.";
const counts = (total = 0) => ({
  now: 0,
  today: 0,
  fyi: total,
  decisions: 0,
  approvals: 0,
  held: 0,
  digests: 0,
  total,
});
const base = (o: Partial<InboxData> = {}): InboxData =>
  ({
    version: 1,
    observedAt: "2026-09-29T19:15:05.000Z",
    partial: false,
    stale: false,
    error: null,
    items: [],
    counts: counts(),
    ...o,
  }) as InboxData;
type Item = InboxData["items"][number];
const item = (
  i: number,
  source: Item["source"] = "held",
  urgency: Item["urgency"] = "now",
): Item => ({
  key: `held-${i}`,
  source,
  ref: null,
  title: `t${i}`,
  summary: "s",
  projectId: null,
  urgency,
  createdAt: "2026-09-29T19:00:00.000Z",
  unread: true,
});
// The shipped (u5) headline, kept here as the fail-before: it read counts alone.
const legacy = (d: InboxData) => {
  const urgent = d.items.filter((i) => i.source !== "held" && i.urgency === "now").length;
  return urgent ? "urgent" : d.counts.total ? "some" : ALL_CLEAR;
};

test("U5-D01 fail-before: the u5 headline showed the all-clear for the live failure shape", () => {
  const live = base({ stale: true, partial: true, error: "Management unavailable" });
  assert.equal(legacy(live), ALL_CLEAR);
});

test("U5-D01: no all-clear when any source failed; what failed is named; retry offered", () => {
  const shapes: Array<[string, InboxData | undefined, boolean, unknown]> = [
    [
      "controller unreachable, nothing read yet",
      base({ stale: true, partial: true, error: "Management unavailable" }),
      false,
      undefined,
    ],
    ["partial with no items", base({ partial: true }), false, undefined],
    [
      "partial, held section unreadable",
      base({ partial: true, unreadable: { held: 3 } }),
      false,
      undefined,
    ],
    ["the read itself failed", undefined, false, new Error("Request failed")],
  ];
  for (const [name, d, pending, err] of shapes) {
    const h = inboxHeadline(d, pending, err);
    assert.notEqual(h.text, ALL_CLEAR, name);
    assert.equal(h.failed, true, name);
    assert.equal(h.canRetry, true, name);
  }
  assert.match(
    inboxHeadline(base({ stale: true, partial: true, error: "Management unavailable" }), false)
      .text,
    /could not be read/,
  );
  assert.match(
    inboxHeadline(base({ stale: true, partial: true, error: "Management unavailable" }), false)
      .problem ?? "",
    /could not reach the service/,
  );
  assert.deepEqual(
    inboxHeadline(base({ partial: true, unreadable: { held: 3, digests: 1 } }), false).missing,
    ["held messages", "daily digests"],
  );
});

test("U5-D01: counts stay lower bounds when partial; a stale last-good list says so", () => {
  const d = base({
    partial: true,
    items: [item(1, "decision", "now"), item(2)],
    counts: { ...counts(2), now: 2 },
  });
  assert.match(inboxHeadline(d, false).text, /^At least 2 in all, at least 1 needs you now/);
  const stale = base({
    stale: true,
    partial: false,
    error: "timed out",
    items: [item(1)],
    counts: counts(1),
  });
  assert.match(
    inboxHeadline(stale, false).text,
    /^Showing the last inbox that could be read: 1 in all/,
  );
});

test("the all-clear still appears when every source was read and nothing is waiting", () => {
  const h = inboxHeadline(base(), false);
  assert.equal(h.text, ALL_CLEAR);
  assert.equal(h.failed, false);
  assert.equal(h.canRetry, false);
  assert.equal(inboxHeadline(undefined, true).text, "Checking what needs you…");
});

test("personal inbox surfaces only open human packets, retaining all held and FYI records", () => {
  const packet = {
    ...item(1, "decision", "now"),
    ref: "decision:00000000-0000-4000-8000-000000000001",
  };
  const held = item(2, "held", "now");
  const answered = {
    ...item(3, "decision", "fyi"),
    ref: "decision:00000000-0000-4000-8000-000000000002",
  };
  const data = base({
    items: [held, packet, { ...packet, key: "same-packet-report" }, answered],
    counts: counts(4),
  });
  const view = humanInboxItems(data);
  assert.equal(view.confirmed.length, 1);
  assert.equal(view.retained.length, 1);
  assert.equal(view.other.length, 2);
  assert.equal(data.items.length, 4, "classification does not consume any source record");
  assert.equal(humanInboxItems({ ...data, stale: true }).confirmed.length, 0);
  assert.equal(humanInboxItems({ ...data, stale: true }).unknown, true);
});

import { execFile } from "node:child_process";
// G6 (G-FIXES-REPORT.md): the production human notifier for messages held for a human-held prime seat. A macOS user
// notification on this Mac, so the human lead learns a message is waiting without anything being typed into their
// session. Metadata only: seat identities (controller-validated slugs and project UUIDs, re-checked here), counts --
// never a message's text, which is untrusted (DESIGN-E T6) and is read in Fulcra › Inbox (J3).
const SEAT = /^[A-Za-z0-9-]{1,64}$/;
export function heldNoticeText(n) {
  if (
    !SEAT.test(n.seat) ||
    !Array.isArray(n.fromSeats) ||
    !n.fromSeats.length ||
    !n.fromSeats.every((s) => SEAT.test(s)) ||
    !Number.isSafeInteger(n.count) ||
    !Number.isSafeInteger(n.waiting)
  )
    throw Error("Unexpected held-notice shape");
  return {
    title: "Fulcra",
    subtitle: `Held for prime seat ${n.seat}`,
    body: `${n.count} new message${n.count === 1 ? "" : "s"} from project seat ${n.fromSeats.join(", ")}; ${n.waiting} waiting in all. Read them in Fulcra › Inbox. The text is not shown here.`,
  };
}
export function macHeldNotifier(
  run = (file, args) =>
    new Promise((resolve, reject) =>
      execFile(file, args, { timeout: 10000 }, (e) => (e ? reject(e) : resolve())),
    ),
) {
  return async (n) => {
    const t = heldNoticeText(n),
      q = (v) => JSON.stringify(v); // the fixed template above (plain ASCII plus the › separator): JSON quoting is valid AppleScript quoting
    await run("/usr/bin/osascript", [
      "-e",
      `display notification ${q(t.body)} with title ${q(t.title)} subtitle ${q(t.subtitle)}`,
    ]);
  };
}

// H6 item 6: a Claude session under human control stopped at its usage limit. Metadata only: the session id (a UUID,
// re-checked) and the reset time the CLI printed (re-checked against a narrow pattern); nothing was sent to it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  RESET = /^[A-Za-z0-9 :,()/_+-]{1,60}$/;
export function limitNoticeText(n) {
  if (!UUID.test(n.session) || !RESET.test(n.reset))
    throw Error("A usage-limit notice names only a session id and its reset time");
  return {
    title: "Fulcra",
    subtitle: "Claude usage limit",
    body: `Session ${n.session.slice(0, 8)} stopped at its usage limit; resets ${n.reset}. ${n.heldBack ? "It has been resumed often today, so it was left for you." : "It is under your control, so nothing was sent to it."}`,
  };
}
export function macLimitNotifier(
  run = (file, args) =>
    new Promise((resolve, reject) =>
      execFile(file, args, { timeout: 10000 }, (e) => (e ? reject(e) : resolve())),
    ),
) {
  return async (n) => {
    const t = limitNoticeText(n),
      q = (v) => JSON.stringify(v);
    await run("/usr/bin/osascript", [
      "-e",
      `display notification ${q(t.body)} with title ${q(t.title)} subtitle ${q(t.subtitle)}`,
    ]);
  };
}

// The controller journal's delivery capacity, decided once. Every native create/send/resume/wake is one deliveries row,
// and rows are never removed (they carry idempotency and audit: a retried messageId must find its original row).
//
// Automation (worker-completion wakes, manager worker creation, leadership handoffs) may use the journal only up to
// AUTOMATION_LIMIT, so MANUAL_RESERVE rows always remain for an operator to take over, recover and finish work by hand.
// Before G3 (G-FIXES-REPORT.md) these were magic numbers in six places: 1000 total, and automation stopped at 500. The
// live journal passed 500 on 2026-09-24 (582 rows), which silently switched off every wake and every manager creation
// while reporting "Supervision link or wake capacity reached" -- links were at 13 of 32.
//
// This is still a bounded journal, not a retention scheme: at ~50 rows a day, 10,000 rows is months, not forever.
// Retention (archiving settled rows without breaking idempotency or the admission guard's parent lookups) is an open
// design item for the owner, recorded in G-FIXES-REPORT.md.
export const JOURNAL_CAPACITY = 10000;
export const MANUAL_RESERVE = 1000;
export const AUTOMATION_LIMIT = JOURNAL_CAPACITY - MANUAL_RESERVE;
export const deliveryCount = db => Number(db.prepare('SELECT count(*) n FROM deliveries').get().n);

// Browser cases that failed CI without a code change and have no fix yet.
// They run in the non-blocking browser-quarantine job, not in the required
// shards. A case returns to the required shards after 20 passing repeats
// without retries. Each key is "<spec file> › <describe titles> › <test title>".
export const QUARANTINED_BROWSER_TESTS = new Map([
  [
    // FU-259: the backdrop click at y=24 lands on the sheet title.
    "bottom-sheet-reopen.spec.ts › mobile bottom sheet reopen › sheets reopen and model search returns to configuration",
    "FU-259",
  ],
  [
    // FU-271: the startup failure text does not appear within 10 s.
    "creation-idempotency.spec.ts › retrying failed agent initialization preserves its workspace",
    "FU-271",
  ],
  [
    // FU-283: the same startup failure text does not appear.
    "new-workspace-codex-mode-preferences.spec.ts › New workspace Codex mode preferences › keeps Full Access as the global Codex mode after the workspace draft auto-submit handoff",
    "FU-283",
  ],
  [
    // FU-398: the top-up date field is not found on both tries.
    "api-account-spend.spec.ts › API dollars from the durable account ledger fit all required viewports",
    "FU-398",
  ],
]);

export function isQuarantined(key) {
  return QUARANTINED_BROWSER_TESTS.has(key);
}

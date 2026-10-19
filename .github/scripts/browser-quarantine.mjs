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
  [
    // FU-399: the restarted settings control is not found on both tries.
    "daemon-lifecycle.spec.ts › settings restart waits for a replacement worker while retaining the supervisor",
    "FU-399",
  ],
  // The cases below failed in 10 repeats without retries on main ddf11122d (CI 39314850707).
  [
    // FU-300: 4/10. After the Settings sheet closes, the Usage sheet stays fully extended.
    "usage-sidebar-item.spec.ts › Usage item › pinned windows show in the sidebar, follow the used/remaining toggle and persist",
    "FU-300",
  ],
  [
    // FU-251: 2/10. One failed image load leaves "Image unavailable" with no retry.
    "agent-tab-image-stability.spec.ts › switching between settled agent tabs keeps a real assistant PNG rendered",
    "FU-251",
  ],
  [
    // FU-250: 2/10. Same image cause as FU-251.
    "agent-tab-image-stability.spec.ts › reloading a timeline anchors near-tail assistant image growth",
    "FU-250",
  ],
  [
    // FU-248: 1/10. Same image cause as FU-251.
    "agent-tab-image-stability.spec.ts › a real assistant PNG remains reachable through pagination and remount",
    "FU-248",
  ],
  [
    // FU-257: 1/10. Same image cause as FU-251.
    "assistant-selection-copy.spec.ts › copying a selection across an assistant image keeps its Markdown source and alt text",
    "FU-257",
  ],
  [
    // FU-255: 2/10. The Retry button stays enabled while its response is held.
    "agent-timeline-sync-retry.spec.ts › Agent timeline sync retry › a refused catch-up offers a retry that reports pending, failure, and recovery",
    "FU-255",
  ],
  [
    // FU-246: 1/10. The scrolled-away viewport offset reads 0.
    "agent-stream-ui.spec.ts › Agent stream UI › keeps the viewport fixed when delayed authoritative history arrives after scroll-away",
    "FU-246",
  ],
  [
    // FU-252: 1/10. Older history does not load from the keyboard.
    "agent-timeline-pagination.spec.ts › Agent timeline pagination › loads older history when the user navigates to history start with the keyboard",
    "FU-252",
  ],
]);

export function isQuarantined(key) {
  return QUARANTINED_BROWSER_TESTS.has(key);
}

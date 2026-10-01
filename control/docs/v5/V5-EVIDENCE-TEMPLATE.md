# V5 fresh-account evidence

Status: **NOT RUN** (change only after execution). Fixture runs are not acceptance.

- Operator / date / macOS version:
- Test account short name / UID (private evidence only):
- App path / isolated PASEO_HOME / loopback port (private):
- Original V4 product/control commits, build ID and app digest:
- Upgrade product/control commits, different build ID and app digest:
- V4 handoff/readiness/auth/stop instructions and shipped-path proof:
- Control scanner commit and digest:
- Trial provider authority (no credentials):
- Protected home / live PASEO_HOME coverage (private):
- Baseline report / capture time:

Use PASS, FAIL, BLOCKED or NOT RUN; do not leave skipped rows marked PASS. Reference actual files in the screenshot/evidence column. Never include tokens, passwords, cookies or raw environment dumps.

| Step | Expected | Actual | Screenshot / evidence | Pass/fail |
|---|---|---|---|---|
| Setup | Separate standard user; no sharing/migration; separate login Keychain | | | NOT RUN |
| Baseline | Taken before installation; no new launch agents | | `baseline.json` | NOT RUN |
| Install | Verified unsigned app in this user's Applications; local first-open exception only | | | NOT RUN |
| 01 First launch | Command Centre off; no inherited state | | `01-first-launch.png` | NOT RUN |
| 02 Enable | Restart explained; one ready controller; private config | | `02-enable-restart.png` | NOT RUN |
| 03 Organisation | Clear empty state | | `03-empty-organisation.png` | NOT RUN |
| 04 Project | Named test project added once | | `04-project.png` | NOT RUN |
| 05 Session | Session starts; named sidebar title, not UUID | | `05-named-session.png` | NOT RUN |
| 06 Inbox | Waiting labels and Open in Fulcra work; viewing preserves hold | | `06-inbox.png`, `06-open-in-fulcra.png` | NOT RUN |
| 07 Search | Correct match and useful empty result | | `07-session-search.png` | NOT RUN |
| 08 Changes | Correct local file diff opens | | `08-changes.png` | NOT RUN |
| 09 Management | Authenticated reversible action works once | | `09-management.png` | NOT RUN |
| 10 No auth | Supported probe refused; no state change or fallback | | `10-no-auth.png` | NOT RUN |
| 11 Close window | Background service and controller keep serving | | `11-window-closed.png` | NOT RUN |
| 12 Quit/relaunch | Daemon keeps serving; app reconnects; no duplicate/lost state | | `12-quit-relaunch.png` | NOT RUN |
| 13 Disable | Controller stops; plain Fulcra works | | `13-disabled.png` | NOT RUN |
| 14 Re-enable | Same logical state returns; one ready child | | `14-restored.png` | NOT RUN |
| 15 Upgrade | Different rebuilt app; state and auth carried over; no-auth still refused | | `15-upgrade.png` | NOT RUN |
| Checker after 02 | All live checks PASS | | | NOT RUN |
| Checker after 11 | All live checks PASS | | | NOT RUN |
| Checker after 14 | All live checks PASS | | | NOT RUN |
| Checker after 15 | All live checks PASS; scanner checks rebuilt bundle | | | NOT RUN |
| Access isolation | Trace covers protected home/live state and ports throughout lifecycle, no accesses | | | NOT RUN |
| Keychain isolation | Auth belongs solely to trial login Keychain; protected items untouched | | Redacted V4 auth diagnostics | NOT RUN |
| Rollback | Only test app and test command-centre state removed; test processes stopped | | | NOT RUN |
| Teardown | Evidence retained; human removes correct test account/home | | | NOT RUN |

## Exact observations

- Management action / target / before / after / reversal:
- No-auth probe (redacted) / transport / response / unchanged state:
- Child readiness and owner evidence at each restart:
- Close-window / quit behaviour and probe timestamps:
- Logout/reboot behaviour: NOT RUN unless explicitly tested (record separately):
- Upgrade before/after logical IDs, counts and build identity:
- Trace method, interval, process coverage and blind spots:
- Unexpected launchd changes and investigation:
- Failures/blockers and responsible owner:
- Permission prompts or tool refusals:
- Final gate decision, decision-maker and evidence links:

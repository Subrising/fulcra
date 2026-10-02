# Fulcra live status — 11 September 2026

Full goal: active and incomplete. The owned Paseo service now runs real first-class Claude and Codex sessions, shared exact-memory reads, restart continuity, automatic write-permission handling and event-triggered peer review. Broader orchestration and retrieval work continues.

| Capability             | Observed result                                                                                                                                                            | Limit                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Product installation   | `@getpaseo/cli@0.8.0` installed with exact top-level dependency and npm lockfile at `/path/to/volume/openclaw/projects/orca-paseo-20260911`                                | Daemon and existing UI running; both providers completed actual work                                                                  |
| Provider discovery     | Paseo locates Claude 2.1.267 and Codex CLI 0.154.0 on mini                                                                                                                 | Actual mini turns now prove Claude Opus 5 and Codex GPT-6-Astra admission                                                             |
| Codex authentication   | Native `codex login status`: logged in using ChatGPT                                                                                                                       | Trial and peer-review turns completed                                                                                                 |
| Claude authentication  | Mini native interactive Claude Opus 5 returned READY using the current login                                                                                               | Mini Paseo turn completed; MacBook Codex login valid, MacBook Claude login remains expired                                            |
| ADW                    | R2 change `20260911-isolated-paseo-foundation-and-sh`; ideation, contract and architecture recorded                                                                        | Challenge d5ab7d70af3f recorded APPROVE/PASS; automatic classification is R3; final review and required gate checks still outstanding |
| Shared-memory status   | Native wrapper returned 1,549 files / 16,772 chunks, six shared roots and private-root classification                                                                      | Status is not search success or source freshness proof                                                                                |
| Canonical source write | New dated leadership policy saved in existing shared-vault decisions root                                                                                                  | Source capture is not automatic indexing or universal model consumption                                                               |
| Exact read, mini       | Existing `shared_memory_read` MCP tool returned 34 lines, source hash and `shared` disclosure                                                                              | Both actual providers called the added tool and cited the matching hash                                                               |
| Private-scope boundary | Same live MCP server returned `DENIED` for main's private USER.md                                                                                                          | Live facade denies private USER.md, an SSH file and an otherwise-shared research file outside the decisions-only scope                |
| Cross-Mac exact read   | SSH client on MacBook invoked mini's same MCP server and returned the identical source hash                                                                                | Does not establish phone access, model consumption, offline use or bidirectional session messaging                                    |
| Native memory search   | Gateway timeout at 10s; local wrapper timed out with 45s and 20s configured child deadlines, observed process close about 90s and 88s                                      | Unresolved; not silently replaced by a mock or claimed as working                                                                     |
| Embedding service      | Existing local embeddinggemma endpoint returned 768 dimensions in 142ms                                                                                                    | One direct query; does not identify the cause of native search's delay                                                                |
| Timeout diagnosis      | Launcher child survived the wrapper deadline; process-local no-respawn plus compile-cache-disable returned at 10,031ms for a 10s deadline with no remaining search process | Tested bounded failure; overrides not installed globally or integrated into sessions; search still unresolved                         |

## Memory evidence

Canonical source: `/path/to/user/shared-vault/decisions/orca-leadership-policy-20260911.md`.
SHA-256: `<SHA256>`.

Raw local protocol evidence: `runtime/memory-mcp-probe.json`.
Raw cross-Mac protocol evidence: `runtime/memory-macbook-ssh-probe.json`.
These local evidence files are intentionally outside Git tracking. They contain actual JSON-RPC responses, not generated expected outputs.

The remote test was driven from this mini task: test client → MacBook SSH process → mini canonical MCP server. Existing SSH authentication worked in both directions without forwarding credentials. The MacBook's standard shared-vault decisions directory did not contain the new file at the time of checking; remote canonical reads therefore address a demonstrated stale-copy gap. They do not prove synchronization is working.

The native search failure emitted slow SQLite transaction and agent database-open warnings. Status/read succeeded, and a direct embedding request succeeded. That narrows the investigation but does not prove a root cause. Do not repeatedly rerun the same failed search without changed evidence or conditions.

Further own-process profiling established a separate timeout-cleanup defect and a process-local mitigation. See MEMORY-INVESTIGATION.md for successful and failed attempts and the remaining search uncertainty. The subsequent native mini Claude readiness turn succeeded; earlier expired-login evidence is historical.

## Observed orchestration proof

- Mini daemon: server `<SERVER_ID>`, home `/path/to/volume/openclaw/projects/orca-paseo-20260911/home`, loopback 6791, relay disabled, automatic control MCP injection disabled. Controller password remains outside Git and outside daemon/provider environments; same-user shell access is explicitly not sandboxed.
- Claude retained the observed native conversation across the restart; captured daemon and native identifiers are withheld.
- Codex retained the observed native conversation across the restart; captured daemon and native identifiers are withheld.
- Both retained native IDs and recalled distinct conversation facts without tools after daemon restart. Claude's existing context-mode hook also retained the first prompt; this limits claims about an isolated recall mechanism.
- All 28 captured owned processes were absent after the first stop. macOS process-environment inspection failed a synthetic control, so the final exact-read shim explicitly records native-status PIDs before exec rather than treating invisible environment markers as proof.
- `src/revise.mjs` answered two distinct live Write requests and woke Codex from Claude's idle event. Codex saved `peer-review.md` with ACCEPT. There were no natural duplicate notifications in that run; duplicate-delivery and durable controller restart handling remain to be tested.
- Existing UI shows conversations, tool calls, provider selection, host and task states. HTTPS access succeeded from the MacBook; unauthenticated API access returned 401. A 390×844 browser check opened the persistent Claude conversation and composer. This is not a physical iPhone test.
- Private phone URL: https://fixture-host.host.example:8443/ . Requires the existing Tailscale network. In Direct connection use that hostname, port 8443, SSL enabled and the password stored in `home/controller.secret`. Existing port 443 proxy is unchanged.

Evidence: `runtime/live-proof-summary.json`, per-provider before/restart/recall JSON, initial and revision timelines, `runtime/revision-result.json`, `runtime/remote-auth-status.json` and before/after Tailscale configurations. Raw runtime evidence is local and ignored by Git; final review still needs a frozen evidence manifest.

## Next execution steps

1. Extend canonical shared-memory retrieval and correction handling across entry points while keeping the native search failure visible.
2. Add cross-host native sessions and explicitly owned supervisor communication using supported product APIs; verify human takeover and duplicate/reconnect behavior.
3. Complete the scoped ADW gate with real build/security and independent acceptance evidence. Current local deployment is a working trial, not a passed final release gate.
4. Advance architecture/deployment traceability and leadership decision learning against ARCHITECTURE.md and PROOF-PLAN.md. Retain Radius holds and existing repair ownership.

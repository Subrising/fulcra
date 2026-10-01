# Decision and artifact workspace — AIN-78

The selected task now connects its outcome, situation, alternatives, recorded decision, published files and review declarations to the existing persistent conversations. The user directed implementation to proceed during Claude cooldown on September 13; required independent ADW reviews remain pending. This is an installed working candidate, not a claim of reviewed release.

## Choice and boundary

Extend the existing private Paseo Fulcra surface. Reuse the canonical decisions directory and current task authority check. A separate dashboard would duplicate authentication and task selection; a new database would compete with canonical memory. Markdown-only navigation would omit freshness and exact output inspection. The chosen addition is read-only and does not create execution or decision authority.

Each task may publish `orca-outcome-<task UUID>.md` in `/path/to/user/shared-vault/decisions` with exactly one `orca-outcome` JSON fence. The strict schema lives in `orca-organization/shared/outcomes.ts`. Include one to eight alternatives with concrete changes, benefits, risks, dependencies and examples; record an actual choice only when it exists. A recommendation does not establish human selection. Perspective controls change the questions to consider, not recorded facts or authority.

Publish up to sixteen flat Markdown, CSV or text files with SHA256, kind and optional recorded producer session. Reviews name their saved review file and exact reviewed artifact hashes. All input hashes, review bytes and target hashes must match for review currency. This is a check of bytes against declarations, not reviewer identity authentication or an ADW gate. Runtime artifacts are historical evidence; existing session observations remain the live runtime view.

The final fictional Harbor exercise (AIN-77) is the initial published record. Its alternatives remain fictional, the brief's pilot recommendation is conditional, and no real rollout decision is invented. The four original files remain byte-for-byte unchanged.

## Disclosure and failure behavior

Paseo's authenticated plugin context is required. Each request checks the selected task through the current controller: active eligible task or retained enrollment/delivery history. No task access is inferred from a client-supplied path or a cached catalog hint.

Only explicitly referenced flat regular files from the fixed canonical directory are readable. No symlinks, nested or absolute paths, binary/NUL content, or files over 64 KiB. Reads are bounded and verify file identity and metadata before and after reading. The publishing user and local filesystem owner are trusted; this is not isolation against a malicious same-UID process replacing parent directories concurrently.

An artifact request must carry the displayed record hash. Changed records or changed output bytes withhold content. The view disables reads for stale observations and hides already-open content after a fresh observation detects changed files. Times are observation times, not continuous assurances. Missing, invalid and inaccessible records do not imply success. Saved text is rendered literally.

## Verification and rollout

The actual server and schema tests exercise changed inputs/outputs/reviews, target hash mismatch, authorization loss/outage, ambiguous declarations and real filesystem boundaries. Registered route tests cover authentication and retained task access. Component tests cover alternatives, perspective selection, literal content, producer navigation and stale-content hiding. Installed compiler, plugin RPC and real browser evidence are under the worktree's ignored `runtime/` directory. Browser phone dimensions are simulated; no physical-device claim.

Only the owned `orca-organization` plugin path is changed through Paseo's supported config patch/reload. Immutable candidates preserve rollback. No controller restart, task instruction, delegation, external message or journal mutation is required. Prior installed candidate: `/path/to/volume/openclaw/projects/orca-organization-releases-20260913/bf1df3acf2c7924c/orca-organization`. Recover by restoring that plugin path and reloading the plugin. Preserve other plugin entries and recheck configuration before patching.

Independent challenge/correctness/security/approval work is queued after cooldown; no pre-code challenge is claimed. Coverage, mutation and other required delivery evidence must be completed and recorded against the exact frozen tree before ADW can report PASS. Source or contract changes invalidate affected evidence.

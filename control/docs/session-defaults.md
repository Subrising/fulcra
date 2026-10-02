# Session defaults: what a new session spawns with

Every session this controller creates gets its model, mode, thinking level and
approval options from **one selector**, `src/control/provider-mode.mjs`. This
page is how you change what that selector answers.

## Precedence

```
per-spawn override   >   role default   >   installation setting   >   product default
```

A caller that asks for something specific always wins. A **role default** applies
when the creation path knows what the session is for (see "Role defaults" below)
and the installation has configured that role. An installation setting sits under
that and applies to everything that does not ask. The product defaults apply when
none of those does. With no `roles` configured, or no role on the request, the
answer is exactly what it was before roles existed.

|                          | claude                     | codex               |
| ------------------------ | -------------------------- | ------------------- |
| product default model    | `claude` — follow the host | `codex/gpt-6-astra` |
| product default mode     | `auto`                     | `auto-review`       |
| product default thinking | `medium`                   | `high`              |
| product default ask pin  | none                       | not applicable      |

**A bare family means "use whatever the host advertises as its default".** It is
not a missing value. The controller asks the installed provider for its model
inventory and takes the one marked `isDefault` — which is what
`agents.providers.<provider>.additionalModels` in the host's `config.json`
configures. A value containing a slash is an explicit pin and is passed to the
provider untouched, so it freezes that session on the release it names.

claude is bare so that moving the host's default moves the next session.
codex is pinned because this controller has verified claude's inventory carries
exactly one `isDefault` and has **not** verified the same for codex; resolution
fails rather than guessing when the default is not unique. Set
`models.codex` to `codex` to make codex follow its host too.

claude's `medium` is deliberate: a session comes up Medium, and a task that
needs more asks for it — per spawn, in this file, or from the app's own effort
control. codex keeps `high`; its effort scale is its own and this change did not
measure it.

`auto` is Claude's classifier mode — permission prompts are reviewed by a model,
not skipped. `auto-review` is Codex's closest supported automatic policy: the
same workspace-write permissions as its default, with eligible approvals routed
through the auto-reviewer. Neither is a bypass.

## Where the file lives

**Ordinary installation** — `$CONTROLLER_HOME/session-defaults.json`, where
`$CONTROLLER_HOME` is the controller's own directory (the one holding
`journal.sqlite` and `grants/`). Ask the controller rather than guessing:

```
session-defaults          # RPC; reports settings.path, settings.present
```

**Portable installation** (`ORCA_HOME` set) — the `defaults` key inside
`$ORCA_HOME/config.json`, which already existed. Nothing about portable
installations changed.

**One limit, on the model only.** A portable config.json must already carry a
`providers` map, and that map wins over everything here — including a per-spawn
override. So on a portable installation `defaults.models` changes nothing. The
map's validator accepts a bare family, so set `providers.claude` to `"claude"`
if you want a portable install to follow its host's default model. Mode,
thinking and ask are unaffected and behave exactly as described above.

The file is read **at each spawn**, so an edit applies to the next session
created. No controller restart is needed.

## Format

```json
{
  "version": 1,
  "defaults": {
    "thinkingOptionId": "medium",
    "models": { "claude": "claude", "codex": "codex/gpt-6-astra" },
    "modes": { "claude": "auto", "codex": "auto-review" }
  }
}
```

Every key under `defaults` is optional; omit what you do not want to change.
`thinkingOptionId` is one of `off, minimal, low, medium, high, xhigh, max`.

`models` takes either a bare family — `"claude"`, follow the host's advertised
default — or an explicit `family/model-id` pin, whose family must match the key
it sits under. A value with path or shell structure in it is refused: this
string reaches a process launch.

**There is deliberately no `ask` key in the example above.** It is a real
setting and the next section explains it, but an example is something people
copy, and the example this page used to carry was `"ask": {"claude": ["Write",
"Edit"]}` — the exact pin that makes a session on automatic approval prompt
before every write. Do not start from it.

`modes` accepts only modes the provider actually has, and only those this
controller will select:

| provider | selectable                               |
| -------- | ---------------------------------------- |
| claude   | `plan`, `default`, `acceptEdits`, `auto` |
| codex    | `auto`, `auto-review`                    |

Anything else is refused by name, with the selectable list in the message — a
typo such as `autoo` is rejected rather than passed through to session creation.
`bypassPermissions` and `full-access` are real provider modes and are refused
separately, for the reason in the next section.

The file must be **owned by you and private** — mode `0600`, in a canonical
directory, not a symlink. This is the same rule the portable config already
applies. A file that exists but fails these checks makes the controller
**refuse**, rather than falling back to defaults: silently ignoring a settings
file would hand a session defaults its operator believes they changed.

```sh
install -m 600 /dev/null "$CONTROLLER_HOME/session-defaults.json"
$EDITOR "$CONTROLLER_HOME/session-defaults.json"
```

## Role defaults

`defaults.roles` sets the model, effort (`thinkingOptionId`) and, optionally, the
mode per **role** — what the session is for — so that planning, orchestration
and implementation sessions come up differently without every caller asking:

```json
{
  "defaults": {
    "roles": {
      "planning": { "claude": { "model": "claude/claude-opus-5-5", "thinkingOptionId": "high" } },
      "orchestration": {
        "claude": { "model": "claude/claude-opus-5-5", "thinkingOptionId": "medium" }
      },
      "implementation": {
        "provider": "claude",
        "claude": { "model": "claude/claude-sonnet-5-5", "thinkingOptionId": "high" }
      }
    }
  }
}
```

- Roles are a closed set: `planning` (planning, architecture, review),
  `orchestration` (orchestrators, supervisors, managers, project leads) and
  `implementation` (workers).
- Each role holds an entry per provider. A role with no entry for the provider
  being created falls through to the installation setting, so a Codex session
  under a role configured only for Claude is exactly as before.
- `provider` is used only when the caller names **no** provider. An explicit
  provider always wins.
- `model` must be a `family/model-id` pin of the provider it sits under, or the
  bare family, exactly as for `models`.
- `modeId` is accepted, but refused and unsupported modes are refused here as they
  are everywhere else.

**Where the role comes from.** Only creation paths that know the purpose pass
one:

| Path                                                                      | Role                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `manager_create_worker`                                                   | always `implementation`                                      |
| `role_start_session`, and a seat accepting a session request              | `implementation` unless the lead asks for `planning`         |
| operator `create`, the Command Centre create form, the conversation skill | the `role` the caller gives, if any                          |
| Book (MacBook) sessions                                                   | resolved on the controller with the same rules, then carried |

Orchestrators and project leads are usually **seated after they are created**,
and a live session's model is never changed. So create a lead with
`role: "orchestration"`. If a seated orchestrator's model or effort differs from
the orchestration default, the Inbox shows an attention item; nothing switches
it automatically.

**Only what the installed provider offers is launched.** A role default whose
model or effort the installed provider does not list falls back one level, and
the creation result names the fallback (`fallback: {field, requested, used,
reason}`). An explicit request that the provider does not offer is refused
before anything is created. `session-defaults` reports, per role, what is
configured, what is effective, and whether the provider offers it.

## The `ask` pin, and why it is the one that bites

`ask` lists tools that must prompt for confirmation. It only ever **adds**
prompts, so it needs no refusal list. What matters is that it is configured
**alongside** the mode rather than instead of it: a session can carry
`mode: auto` and an ask list at the same time.

That produces a confusing symptom. Someone reading only the mode sees `auto` and
expects no prompts, while the session still asks before every `Write` and
`Edit` — which looks exactly like the automatic default never having been
applied, when it is really a stale ask pin from an older creation.
`session-defaults` reports `askConfiguredWithAutomatic: true` whenever both are
configured together, so the combination is visible without inspecting a process.

Which of the two wins at prompt time is decided inside Claude Code, not by this
controller and not by the provider adapter, so this page does not state it.

So if sessions are prompting under `auto`, read this file before reading any
code: an ask list configured here explains it completely, and no change to the
controller will stop it. `session-defaults` reports
`source.ask: "installation"` when the list came from this file.

Older sessions created before the automatic default carry a hardcoded
`ask: ["Write", "Edit"]` of their own. See "What settings cannot do" — you
cannot remove that one by editing this file either.

## `auto` is unavailable on Bedrock and Vertex

Claude's `auto` mode is refused by the provider when the session runs against
AWS Bedrock or Google Vertex — `CLAUDE_CODE_USE_BEDROCK` or
`CLAUDE_CODE_USE_VERTEX` set in the session's environment. The restriction
applies to `auto` only; every other claude mode runs normally.

**This matters because `auto` is the product default.** On such an installation
the default path fails: every newly created claude session errors at start
rather than one opt-in configuration being unavailable.

If that is your transport, set a supported mode as the installation default
before creating sessions — which is what this file is for:

```json
{ "version": 1, "defaults": { "modes": { "claude": "acceptEdits" } } }
```

`plan`, `default` and `acceptEdits` are all unaffected.

Recorded from the provider source, which is not in this repository:
`orca-product-integration-20260918`,
`packages/server/src/server/agent/providers/claude/agent.ts:924-944` —
`claudeAutoModeUnavailableOn` returns `"Bedrock"` or `"Vertex"` for those
variables, and `assertClaudeModeCanRun` throws **only** when the mode is `auto`;
every other mode returns early. Neither variable is set on the installation this
was developed against, so nothing here exercises the restriction.

## What the native UI does and does not take from this file

**A session created from the Fulcra app's UI does not read this file.** Editing it
changes sessions the controller creates, and no others.

The app chooses a mode in this order: an explicit choice, then a remembered
preference **the user actually made**, then the provider adapter's own
`defaultModeId`, then the first mode in the catalog. Model and effort follow the
same shape, and where nothing was chosen the app sends no value at all so the
host's own default applies. A remembered value written before the app
distinguished "chosen" from "merely resolved" carries no such mark and is
skipped, which is how a profile that recorded an older model or Always Ask
returns to the host's defaults. Fulcra's installation settings are not in that
chain — there is no reference to this file, or to `ORCA_HOME`, anywhere in the
app.

**The mode still lands where this file would put it, by inheritance**, because
the claude adapter's own default is `auto`. So a UI-created Claude session is on
Auto today without this file's involvement.

What differs is the transport case above, and the difference is worth knowing:

|                  | UI-created                                                                                 | controller-created                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| normal transport | `auto`, from the adapter                                                                   | `auto`, from this file's product default                                                      |
| Bedrock / Vertex | adapter **removes** `auto` from the catalog and falls back to `default` — degrades quietly | selection still asks for `auto` and **fails at creation** unless a supported mode is set here |

So on those transports this file is not an optional preference, it is the fix —
and on every transport it is **inert for the UI**. If you set an installation
default and a UI-created session does not reflect it, that is this limit and not
a fault.

## What settings cannot do

**They cannot select a refused mode.** `bypassPermissions` (claude) and
`full-access` (codex) are refused wherever they appear — product default,
installation file, or per-spawn override. They broaden filesystem and network
access rather than automating approval, which is a security change wearing a
mode's clothes. A settings file is not a way around a refusal, and the
controller refuses to start a spawn that asks for one.

**A refused mode anywhere in the file refuses every spawn.** The whole `modes`
map is validated before a provider is chosen, so naming `bypassPermissions` for
claude also stops codex sessions being created. That is deliberate: a settings
file asking for a refused mode is a file to fix, and letting the providers it
does not name carry on would leave the dangerous entry sitting there unnoticed.

**They cannot name a prototype member.** `__proto__`, `constructor` and
`prototype` are refused as keys anywhere in the file, by name and with that
reason. Values are also read as own properties only, so a polluted prototype
elsewhere in the process cannot supply a mode that validation never checked.

**They cannot change a session that already exists.** Launch configuration is
fixed at creation. `config` is passed to `agents.create` and to nothing else;
nothing in this controller updates the mode, thinking level or options of a live
session, and a resumed session replays the settings it was created with. So:

- Editing this file affects **sessions created after the edit**, and no others.
- An existing session carrying an old `ask` pin keeps it for its whole life,
  across resumes.
- **Recreating the session is the only way to clear it.**

## Checking what you will get

```
session-defaults
```

returns, for each provider, the effective `model`, `modeId`, `thinkingOptionId`,
`ask` and `options`, plus `modelFollowsProviderDefault` (true when the model is a
bare family, i.e. the session will take the host's advertised default), plus
`source` naming where each came from
(`product-default` | `installation` | `override`), `automatic`,
`askConfiguredWithAutomatic`, the refusal lists, and `settings.path` /
`settings.present` so you know which file to edit and whether it exists.

It answers the question "what will a new session get, and why" without creating
one.

The read-only operator view prints the same thing with the file's status beside
it:

```sh
node src/control/role-state.mjs
```

**It will tell you when the running controller predates this setting.** A
controller started before this feature answers `session-defaults` with no
`settings` field and does not read `session-defaults.json` at all — so writing
the file produces no error, no warning and no effect. That is a silent no-op
which looks like a broken setting rather than a controller that has not been
updated, so the view says so explicitly:

```
== SESSION DEFAULTS ==  (what a NEW session spawns with, and which file changes it)
   file: /…/session-defaults.json  (present)
   THE RUNNING CONTROLLER DOES NOT SERVE THIS SETTING -- it predates the feature. The file above is NOT in effect: writing it changes nothing until the controller runs code that reads it.
```

# Portable v0.2

The portable release uses named hosts from `command-centre/config.json`. Only local execution is included; remote execution and the legacy installation steps below are historical and are not shipped. Enable Command Centre through the trusted Fulcra host. V3 host authentication and admission integration and V4 supervision are required before activation.

# Fulcra — what it is and how to use it

For someone who has just installed Fulcra and has never seen it before. Every claim here was checked
against the code; where something is unverified or missing it says so.

## What it is for

Fulcra leads persistent AI sessions. A session keeps working when you close the laptop, and — the part
that matters — **every session belongs to a project and answers to someone.** Months later you can
ask "who decided this, under whose authority, and what did it affect" and get an answer from the
system rather than from memory.

It is not a faster way to run one agent, and it is not a workspace for driving several agents
side by side. If that is what you want, this is more structure than you need.

## The five things to understand

**A project** owns work. It has a name, a description and a status.

**A seat** is a named position in a project — `prime` (accountable across projects) and
`project-orchestrator` (accountable for one project). A seat is a role, not a person or a process.

**A session** is a running agent. A seat is *bound* to a session. That binding goes stale when the
session restarts or is replaced, and the system says so (`sessionGenerationChanged`) rather than
pretending the old authority still holds.

**Ownership** records which project a session belongs to. Four states, and the difference matters:

| state | meaning |
| --- | --- |
| `recorded` | created through a project orchestrator, with a seat. Fully traceable. |
| `declared` | created with a project, but no seat has claimed it yet. |
| `adopted` | a seat claimed a declared session afterwards (`roles-adopt`). |
| `unknown` | no ownership was recorded when the session was created. |

**`unknown` is permanent.** Ownership is keyed on the *creation request*, so if nothing was recorded
at creation there is nothing to adopt later — adoption upgrades a `declared` session, it cannot
invent ownership from nothing. A session created outside the control plane stays outside it. This is
the only irreversible thing in the model, so create sessions through a project orchestrator.

**A channel** is how one seat talks to another. It is not ambient: an operator approves one specific
prime seat talking to one specific project seat, with an expiry and a fixed message count.

## The two things that stop work silently

**A spent allowance.** A seat's session allowance is a fixed number. At zero, new work does not start
and nothing announces it. Raise it with `roles-allowance-set`.

**An expired or spent channel.** The approval carries `expiresAt` and `maxMessages`, both fixed when
it was approved:

- `Channel approval has expired`
- `Channel message allowance reached`
- `The project seat changed since this channel was approved; a new operator approval is required`

**None of these can be renewed.** There is no extend operation — a fresh `channels-open` is the only
route. Re-approving the same channel is the obvious move and it does not exist.

## The three tools

Run these from the control repository.

```sh
# "What will this change do? What is the blast radius?"
node src/control/change-impact.mjs                  # defaults to HEAD~1..HEAD; takes any range

# "What is happening, and is anything stuck?"
node src/control/situation.mjs

# "Can I deploy right now, and what is still mine to decide?"
node src/control/deploy-readiness.mjs
```

`change-impact` leads with the fenced surfaces a change touches — admission guard, role/channel
authority, queued-source classification — each with why it matters, then what else can reach the
changed code, then coverage and its own limits.

`situation` leads with what is wrong, worst first, and gives **one line of what to do** about each.
Real output from this system:

```
BLOCKED  allowance project-orchestrator/0f9e370c
           spent: 1/1 used, 0 remaining. New work will not start and nothing will say so.
           -> Raise it with the roles-allowance-set RPC; until it is raised the seat cannot start new work at all.
```

`deploy-readiness` measures every deployment precondition and prints the command behind each number,
so you can re-run one line instead of trusting it. It separates measurements from constraints: an
ordering rule is printed as a rule, never as a check it performed. There is no path from "could not
measure" to GO.

**Known defect:** `deploy-readiness` calls `observe` on every delegated session, and `observe` takes
over a delegated session that has finished its last turn. It is not read-only in effect despite its
header saying so. Use `list` to read session modes until that is resolved.

## When something looks broken

**"I sent a message and nothing happened."** Sends are **refused while the recipient is running** —
there is no queue. Wait for idle and send again. You cannot correct a brief mid-turn.

**"New work will not start."** A spent allowance. Nothing else will tell you.

**"My message was refused and nobody answered."** A refusal that is still unread needs a *person* to
read it. Retrying creates a second message; it does not deliver the first.

**"This session has no project."** If it reports `unknown` there is no fix. Create the next one
through a project orchestrator.

**Errors mentioning ENOENT, SQLite, or "cannot create sessions"** are usually a correct refusal with
a misleading message. Find out what was refused before assuming something is broken.

**A session changed from `delegated` to `human` on its own.** Something observed it after its turn
ended, or a person typed into it. `handback` re-delegates it while it is idle.

## Limits, stated plainly

- **Two providers.** `claude` and `codex` only — enforced in session creation, memory routing and
  config validation. Other CLI agents are not supported.
- **Two hosts**, `mini` and `macbook`.
- **The app is ad-hoc signed.** Gatekeeper refuses it on first launch for anyone who did not build
  it: right-click → Open, or allow it in System Settings → Privacy & Security. It is not notarized
  and is not currently distributable.
- Fulcra does not schedule work, does not publish anything, and does not act without an approved
  channel or an operator.
- There is no fan-out across agents, no worktree comparison, and no mobile companion.

# Fulcra Command Centre

The Command Centre is the part of the Fulcra app where you see and steer the work your AI sessions do. It shows
who leads what, what each session is doing, what needs your decision, and what has changed. It runs as a plugin
inside the Fulcra app, on the same machine as your Fulcra host.

For example: you open the Command Centre in the morning and see that one project's orchestrator was restarted
overnight, two sessions are waiting for your permission, and a pull request is ready for review, all on one screen.

## What it covers

The Command Centre has six parts. Each has a tab in the app once it is ready; a tab that is not ready is hidden.

### Organisation

Who leads your work: your prime orchestrators, their projects, each project's orchestrator and its sessions, as a
map and as a list. Manage a task from here.

Status: in this release. See [Organisation in detail](#organisation-in-detail) below.

### Inbox

One list of the decisions, approvals and held messages that need you, with a daily digest. Answer on any device.

Status: in this release. See [Inbox, channels and devices](#inbox-channels-and-devices) below.

### Changes

Before-and-after pictures of any pull request, drawn from its code, with its blast radius: what it edits, what depends on it and which tests reach it.

Status: in this release. See [Changes in detail](#changes-in-detail) below.

### Environments

What is running where (for example dev, next and prod), what each needs before it is ready, and one approval to
promote a version to the next step, with automatic rollback if it fails.

Status: in this release. Promotions can be prepared, and run once your paired device can approve them. See
[Environments in detail](#environments-in-detail) below.

### Sessions

Every Claude and Codex session, what it is working on now, and a step-by-step history of what it did and why.

**Replay what any agent did, step by step.** Open Sessions, choose a session and press **Step through this
session**. Under the task title you see a strip of the session's turns. Move along it with the arrow keys, by
swiping the step panel, by dragging along the strip, or by tapping a step. Each step says what changed (the edit,
with its before-and-after lines, or the command and whether it worked) and why (what the agent said or thought
just before). **Only file changes** hides everything else, and **Every change to** a file shows just the steps
that touched it. On a phone the strip becomes a list, with each turn's steps under it. Sessions that were deleted
but whose history was kept can still be replayed. The same view opens beside a conversation as **Step through**.

For example: a session says it finished the monthly report. You step through it and see that it read the report
code, added a total row (the new line is shown in green), and ran the tests: "Ran tests: 12 passed". The step
before the edit shows its reason: "I will add a total row after the monthly rows."

Paths are shown relative to the project folder; a file outside it is shown only as "a file outside the project".
Replaying needs a Fulcra host that keeps a turn index; an older host shows "This needs a newer Fulcra host".
Sessions on your other Mac cannot be replayed yet.

Status: in this release. Step-through needs a Fulcra host update; until then it says so.

**Sessions on your other Macs.** Sessions can run on more than one Mac. Each row says which Mac it is on. The
Command Centre reads your other Mac through its own link to it. When that link is down, the row says "The Command
Centre can't reach Workshop directly". Fulcra may still be connected to that Mac, for example through its relay.
If so, the row adds a line with what Fulcra itself can see, such as "Live from this app's link to Workshop: Idle ·
1 background job". "Working now" counts that session too.

That line is for reading only. Buttons and links on the page never act on it: they keep using what the Command
Centre recorded. When Fulcra cannot reach a Mac either, the page says "Live state unavailable from this app".
Hosts are shown by name: the name Fulcra knows them by, or the Command Centre's configured name ("Mini").
Each other Mac also gets a list of its sessions that are not in Command Centre tasks, read the same way and for
reading only ("Workshop · 4 sessions not in Command Centre tasks"); open them from the sidebar or History. If the
Command Centre can't read a Mac at all, the page says so in plain words with the reason, tries three times, then
stops and offers **Try again**. It never waits forever.
Screenshots are in `docs/screens/sessions/` (`sessions-multihost-*`).

### Trackers

Issues, tickets and pull requests from GitHub, Jira and Bitbucket, linked to the sessions and commits that
worked on them.

Status: in this release. See [Trackers in detail](#trackers-in-detail) below.

## Organisation in detail

The **Organisation** tab opens on your recorded prime/project tree. **Map** is available on wide and compact screens, with an accessible list alternative. Start with active work, expand project branches and select a session to open its exact host conversation or native Changes view. Changes needs an online host and a known Git workspace. Cache-only native events update activity without restoring a provider or loading its history; resident processes alone are not labelled model work.

Map distinguishes recorded prime responsibility, explicit message channels and creation ancestry. It never connects every project to every prime. All recorded prime seats remain top-level when prime reporting relationships are unknown. Native sessions outside expanded branches remain visible; sessions with no recorded responsibility in the bounded observation have a separate group. Coverage, stale/offline states and hidden counts stay visible. Nothing in the graph assigns roles or grants authority.

- **A prime** has a one-line remit, such as _"Owns Platform work · 2 projects"_ or _"Owns 2 projects: Command Centre and Tally"_.
- **A project** shows its orchestrator (_"Tally orchestrator · working now"_, or _"No orchestrator yet"_) and its live work (_"2 of 5 sessions working"_).
- Projects that no prime owns are listed under **No prime yet**. They are never hidden.

**A project's story.** Tap a project to read what its orchestrator last wrote: **Now**, **Next**, **Needs you** and **Risks**, plus what was finished since the last update. The card says who wrote it and when, for example _"Written by the Tally orchestrator, 10 min ago"_. It says **May be out of date** when the update is more than a day old, or when the project has been busy for more than six hours since it was written. Ids and references are behind **Details**.

**Moving a project to another prime.** In the story, tap **Change prime**. Pick the prime, write why in at least 12 characters, and tap **Save**. For example, you move _Tally_ from the Delivery prime to the Research prime because _"Research is taking over all platform and launch work next month"_. The move is one step with one line in the history, and the history below the sheet keeps every change and its reason. If someone else changed it while you were looking, the sheet says _"Changed since you looked; refresh"_ and nothing changes. **Remove prime** stops a prime owning the project. Only the app can make these changes. Agents cannot.

**What owning means.** The owning prime can write the project's story and sees the project in its list under **Organisation › Leadership**. It gets no other control. A project is owned by its own remit if it has one. Otherwise it is owned by the prime that owns its area (for example _Platform work_). Otherwise it has no prime yet.

**Where the stories come from.** Each project's orchestrator publishes its story with the `role_brief_publish` tool. It publishes when health changes, when a job merges, and at least once a day while the project is active. Only that project's orchestrator, or the prime that owns the project, can publish. Personal data such as home folders, email addresses, private host names and tokens is refused. Wording a busy reader would stumble on, such as ids, file paths, code or jargon, comes back to the writer as a warning.

**How it works.** Remits and stories live in the controller (`src/control/remits.mjs` and `briefs.mjs`), in the tables `cc_remits` (at most one active owner per project or area, enforced by the database), `cc_remit_history`, `cc_project_domains`, `cc_project_briefs` (every revision is kept, so the daily digest can read it) and `cc_brief_history`. Remit changes are recorded as made by the operator, because the app cannot yet prove that you made them yourself (CONTRACTS §3.6). Limits: 2,000 remits, 10,000 history rows and 1,000 project areas; 1,000 stories per project and 20,000 in all, and 25,000 story history rows. When any of these is 90% full, including one project's 1,000 stories, the Inbox shows a note such as _"Storage for one project's updates is 90% full"_. At a limit, a change is refused with a sentence saying so. There is no way yet to archive old stories or remits: that is a documented exception for this version (CONTRACTS §1 Capacity, v1.14), and it arrives in a later update. The contracts are in `shared/cc/remit.ts` and `shared/cc/brief.ts`, and the screens are `client/organisation*.tsx`. Screenshots are in `docs/screens/organisation/` and are made with `node verify-organisation-screens.mjs <tooling dir>`.

## Changes in detail

**Changes** shows what a piece of work does to the shape of your system, before you accept it. Open a project in the Fulcra app, go to **Architecture map** and choose **Change**, then pick a pull request. You don't need to draw a map first: Fulcra draws one from the code at both ends of the pull request.

- **Drawn from the code.** Parts are the project's folders and connections are the imports between them. Fulcra splits the folders the pull request edits into finer parts, so the picture is detailed where the change is. Both ends use the same parts in the same places, so a box only appears or disappears when its code did. The map is read from the pull request's commits, never from files on this computer. If those commits aren't on this computer yet, _Fetch the pull request's commits_ fetches only its branch and its base.
- **Blast radius.** Under the summary: the files and parts the change edits, how many files import the changed code directly, how many can feel it through other files (and in which parts), and which changed code files no test reaches. Each changed file names the test to open first.
- **Drawn maps.** When the project also keeps a hand-drawn map, _Drawn map_ shows the same comparison for it.

- **Before and after.** On a wide screen, the map before the change and after it sit side by side. On a phone, choose _Changes_, _Before_ or _After_. New parts are green, removed parts are red with a dashed outline, and changed parts are amber. Each coloured box also says _New_, _Removed_ or _Changed_, so you never have to rely on colour alone.
- **A plain summary.** For example: _"Touches 3 parts of the system. 1 other part depends on what changed. 7 files changed. 2 of 3 changed code files have a test beside them."_ Below it, _What changed_ lists each part in words, and _Also affected_ names the parts that use them.
- **Links.** _Open pull request_ opens the pull request in the app. When a project asks you to accept a change, it attaches the same summary to the question in your **Inbox**, with links to the map before and after and to the work sessions that made it.
- **Pull requests.** For a pull request, _before_ and _after_ are the maps in the pull request's own commits: where it left its base branch, and its latest commit. Nothing on this computer that isn't committed changes them. Reading a file at a commit needs a newer Fulcra host (the v1.16 update). Until your host has it, the view says _Comparison unavailable for this pull request_ and offers to open the pull request instead.
- **"This diagram may be out of date".** This warning appears when a big change (10 or more files, or any file the map is drawn from) did not update the map. Ask for the map to be updated in the same pull request.

For example, a pull request adds product search to a shop. The Change view shows _Product search_ in green, the retired _Weekly reports_ job in red, and _Orders service_ in amber because it now checks stock. The summary says one other part, the shop website, depends on what changed.

**How it works.** The host draws a pull request's maps with `checkout.architecture-change.get` (CONTRACTS v1.17) and keeps them by commit, so a pull request is drawn once per push; checking a pull request's status draws it in the background. The rules are in `orca-architecture-map/generate.mjs`, which prints or writes the same map from a terminal (`node orca-architecture-map/generate.mjs <repo> <commit> [--write <name>]`). Hand-drawn maps live at `.fulcra/architecture/<name>.ir.json`. Parts are matched by their ids, so a moved box is not a change. For a pull request, the app reads both maps at the pull request's commits through the host (`checkout.file-at-commit.get`), and says the comparison is unavailable on a host without it. For a branch without a pull request, it rebuilds the map as it was when the branch started from the branch's own changes. Agents keep maps current with the gate `node orca-architecture-map/validate.mjs <repo> --since <base>` (see `orca-architecture-map/SKILL.md`). Orchestrators build a decision's evidence with `node orca-architecture-map/change-evidence.mjs --root <repo> --pr <pr ref> --base <rev> --head <rev>`, and `node src/control/change-impact.mjs --root <repo> <range>` measures files, dependents and tests for any JavaScript or TypeScript repository. Screenshots are in `docs/screens/changes/`. They come from the made-up shop maps in `orca-architecture-map/fixtures/changes/`, rendered by the product's `architecture-change-view.browser.test.tsx`.

## Trackers in detail

The **Trackers** tab shows one project at a time. It lists the issues and pull requests from every tracker connected to that project, and who worked on each one. Fulcra only reads your trackers. It never comments, closes or changes anything there.

A project can have several trackers, for example its app repository, its website repository and its Jira project. Fulcra reads GitHub, Jira and Bitbucket, in the cloud or on your own server (Jira Data Center and Bitbucket Data Center). Pick the project, tap **Add a tracker**, and choose how Fulcra reads it: a connected account, or (GitHub only) the command-line login already on this computer. That login can change things, so it is labelled "broad access", and Fulcra only ever reads with it. Type the repository (`acme/app` on GitHub or Bitbucket, `ACME/web` on Bitbucket Data Center) or the Jira project key (`ACME`), and tap **Check it**. Fulcra asks the tracker what that name is, and nothing is recorded until you tap **Yes, track it**.

Each item shows a "worked by" trail. For example, issue #42 reads _"#42 → fixed in PR #17 → by session 'Sign-in fixes' → merged 13:10"_. Fulcra builds the trail from four sources:

- **The pull request itself.** GitHub reports a pull request that says _Fixes #42_. Jira's development panel lists the pull requests and commits linked to a ticket.
- **The commits.** A commit's `Fulcra-Session` and `Fulcra-Task` lines name the session and task that made it. These lines count only if they name a session or task Fulcra knows.
- **Where and when the commit was made.** A commit made in a session's own folder while that session was working counts. So does a commit that is only on that task's `cc/<job>` branch.
- **Ticket numbers.** A commit that mentions `#42` counts. So does a Jira key such as `ACME-12` in a commit message, a branch name (`feature/ACME-12-sign-in`) or a pull request title, in any repository of the project.

Under the trail, each step says whether it was reported by the tracker or a commit, or worked out by Fulcra. If a trail is wrong, tap **Correct this**. **Not right: remove** takes a link away, and Fulcra never adds it back by itself. **Worked on by** adds one by hand, and a link you set by hand always wins.

When a tracker cannot be reached, the tab keeps showing the last copy Fulcra saw, marked _last copy_. A signed-out account shows _The account needs reconnecting in Settings › Integrations_. Projects set up before this release (one tracker per project) keep working. They move into the new list by themselves, once the host's shared sign-in store (Fulcra host update P1) is installed.

**How it works.**

- The controller stores the mappings, the latest observations and the links: `src/control/cc-trackers.mjs` and `cc-links.mjs`, with tables `cc_tracker_mappings`, `cc_tracker_items`, `cc_links` and their history.
- The controller enforces which kinds of link are allowed and that a link set by hand wins.
- Connectors are one module each in `server/connectors/`: `github.mjs`, `jira.mjs` (Jira and Jira Data Center) and `bitbucket.mjs` (Bitbucket and Bitbucket Data Center). `registry.mjs` checks each module against CONTRACTS §7.1.
- A connector never holds a token. It is handed an `http` bound to one account (`http.mjs`): the Fulcra host makes the request, adds the sign-in itself, and sends it only to that tracker's own address. The GitHub command-line login is the other `http`.
- Jira's development panel needs a newer host. Until the host allows it, Jira tickets still link through ticket keys.
- A connector refreshes at most once a minute per tracker (every two minutes for Jira and Bitbucket). A signed-out or rate-limited account pauses only the trackers that use it.
- Commits are read from the project's local folders with read-only `git` (`server/connectors/provenance.mjs`), and no network is needed.
- Screenshots are in `docs/screens/trackers/`, made with `node verify-tracker-screens.mjs <tooling dir>`.

### Integrations

**Settings › Integrations** is where you sign Fulcra in to your trackers, the way GitKraken Kepler does it. There is a card for each tracker: GitHub, Jira, Jira Data Center, Bitbucket and Bitbucket Data Center. Each card shows:

- **Connect**;
- the accounts already connected;
- a warning and **Reconnect** when a sign-in stops working;
- **Disconnect** to remove one. If this computer's password store does not confirm the removal, the account shows _Couldn't remove; retry_, Fulcra stops using it, and **Retry disconnect** tries again.

The same screen is also reachable from the **Integrations** button on the Trackers tab. Sign-ins are kept in this computer's own password store (the Keychain on a Mac), never in Fulcra's files. The phone apps never hold them.

**Connecting GitHub with a least-privilege token.**

1. Tap **Connect** on the GitHub card, then **Create one ↗**. That opens GitHub's _New fine-grained personal access token_ page.
2. Under **Repository access**, choose _Only select repositories_, and pick just the repositories you track.
3. Under **Repository permissions**, set **Metadata**, **Issues** and **Pull requests** to _Read-only_. Leave everything else at _No access_.
4. Create the token, paste it into Fulcra, and tap **Connect**. The card then shows the account, for example _"acme-bot (GitHub)"_, as _Connected_.

**Connecting Jira or Bitbucket.** Each card asks only for what that tracker needs, next to a **Create one ↗** link and the read-only permissions to give the token:

- **Jira** (cloud): your site, for example `acme.atlassian.net`, the email address of your Atlassian account, and an API token with `read:jira-work` and `read:jira-user`.
- **Jira Data Center**: your server's address and a personal access token from your Jira profile.
- **Bitbucket** (cloud): the email address of your Atlassian account and an API token with the Bitbucket read scopes.
- **Bitbucket Data Center**: your server's address and an HTTP access token with _Repository read_. For a personal token, also enter your username.

The token goes straight to the Fulcra host and is cleared from the form. The Trackers plugin never sees it again.

When your organisation has registered a Fulcra GitHub app, **Sign in with a code** appears too. Fulcra shows a short code and opens GitHub, where you type it in. Browser sign-in for GitHub, Jira Cloud and Bitbucket Cloud stays hidden until Fulcra has its own sign-in service, because those providers need a server-held secret.

On a Fulcra host without update P1, the screen says _"This needs Fulcra host update P1"_ and explains what still works. That is the GitHub command-line login, and any trackers set up earlier.

## Environments in detail

Environments shows where each version of a project is running, and moves a new version one step at a time, only when
you approve.

- **Dev** is the working copy the team builds on.
- **Next** is the practice copy customers don't see yet.
- **Prod** (shown as "Live") is the version customers use.

For example: Tally's newest changes are on Dev. You press **Promote to Next**. Fulcra makes a clean copy of exactly
that version and runs Next's setup checks, such as "the practice site answers". It then shows what changes (4 files),
how the checks went, and how it would undo it. You approve once, in your Inbox, on your paired device. Fulcra puts the
version on Next and checks that it works. If a check fails, it puts the previous version back by itself.

**What you see.** For each environment, a card shows:

- which version is there, and when and by whom it was put there;
- where it runs;
- whether it is working.

Under the cards is the setup checklist, with each check passed, failed or not checked yet. Version ids, file names and
the step-by-step log sit behind **Details**.

**What is safe by construction.**

- Nothing runs because someone asked. A promotion runs only after your approval on a paired device, and only if
  nothing changed since you were asked. If the version, the steps or the check results changed, it stops before it
  starts.
- Any change to an environment is itself an approval: its name, its place in the path, where it runs, its steps
  or its checks. The old definition stays in use until you approve the new one. A promotion you approved before such
  a change doesn't run; it has to be prepared again.
- A step marked as impossible to undo makes the approval ask you twice.
- Fulcra runs only the scripts you approved: files inside the project's own repository, as they were when the
  environment was proposed (the version is under **Details** on the approval). The version being promoted is given
  to them as a separate copy to read; nothing in it is run by Fulcra, so a changed check script in a new version
  doesn't run until you approve it as part of the environment. Each runs with a time limit
  and only the settings it needs, and never as a shell command. Anything a script starts is stopped when the script
  ends, runs out of time or is cancelled; after a restart, anything still left over is stopped or reported. What it
  prints is kept only after personal paths, private host names and secrets are removed.
- There are no Radius operations: Environments never creates or removes Radius resources.

**Setting it up (operator).**

- **Environments.** A project's orchestrator proposes each environment, and you approve it. An environment says:
  - which repository it comes from;
  - where it runs;
  - its setup checks;
  - its deploy, check and undo scripts.
- **Local copies.** Fulcra reads the local copy of each repository from `environments/repos.json` in the controller's
  home. That file maps each repository key to a folder on the host, for example `{"version": 1, "repos":
{"github:acme/tally": "…"}}`, and it is never stored in the journal.
- **Asking from the app.** Until the decision store can ask on its own behalf, the approval card is asked by the
  project's orchestrator. Pressing Promote in the app prepares everything and says so.

## Inbox, channels and devices

### Inbox

The **Inbox** tab is the one place where your work waits for you. It has four groups:

- **Decisions.** A question a project needs you to answer.
- **Approvals.** A yes or no before something runs.
- **Held messages.** Messages a project lead sent to a seat you are holding yourself.
- **Digest.** A short summary of each project, written every morning.

Each row has a badge. **Now** means a top-level decision, an approval, or a message that has waited more than an hour. **Today** means any other open question. **FYI** means a digest or a note about the system.

**Answering a decision.** Tap the row. The card shows what is going on, the recommended answer first, and two or three options, each with an everyday example. The recommended option is already selected, so one tap on **Choose** answers it. An option that is hard to undo asks you to tap a second time. _Details_ holds the evidence and ids for anyone who needs them.

For example, a project asks _"Where should practice copies of our products live?"_ One option reads _"Fulcra keeps them — like a dress rehearsal on the real stage before opening night."_ You tap **Choose Fulcra keeps them**, and the project that asked is told your answer once. The card then shows who answered. Once you can confirm on a paired device it reads _"You decided on iPhone at 09:14"_. Until then it reads _"Answered by the operator at 09:14, not confirmed on your device"_, because nothing proves it was you. If the question changed while you were reading, the card says _"Changed since you looked"_, and nothing is recorded until you refresh and choose again.

**Held messages.** The list shows who is waiting and for how long, never the message itself. Open it to read the text, mark it read, reply once, or release the hold, so later messages go to the seat directly.

**Digest.** Each morning at 08:00 (this computer's time), Fulcra writes a digest from its own records: decisions waiting and answered, held messages, and the project's latest update. When no update was written, it says _"No project update was written today"_. It never calls an AI model and sends nothing outside Fulcra.

**How it works.** The controller is the only place a decision is stored and the only place an answer is accepted (`src/control/decisions.mjs`, tables `cc_decisions`, `cc_decision_history`, `cc_decision_deliveries` and `cc_digests`). Agents ask with the `role_decision_ask` tool and can read or withdraw their own questions. They can never answer one they asked of you. The contracts are in `shared/cc/decision.ts` and the screen is `client/inbox.tsx`. Screenshots are in `docs/screens/inbox/` and are made with `node verify-inbox-screens.mjs <tooling dir>`.

### Use it from anywhere

Your inbox isn't only in the Fulcra app. You can check it and answer it from your Discord conversation with Fulcra, from a terminal, or by asking a Claude or Codex session "anything waiting for me?". It's the same inbox everywhere: answer a question in one place and every other copy updates to say so.

- **Pairing.** Open the **Channels** tab and choose Discord, Terminal, or Claude or Codex session. You get a 6-digit code that works once, for 10 minutes.
  - In Discord, type the code in your Fulcra conversation.
  - In a terminal, run `fulcra inbox pair <code>`.
- **What a channel shows.** Each question with its options, their everyday examples and the recommendation. Held messages only say that one is waiting: you read them in the app, never in a chat.
- **Answered everywhere.** When you answer anywhere, every other copy changes to say who answered and when: _"You decided on iPhone at 09:14: Use GitHub's built-in copies"_ when your paired device confirmed it, otherwise _"Answered by the operator at 09:14, not confirmed on your device"_. A second attempt to answer is told _"Already answered …"_ the same way, and nothing changes.
- **Who answered.**
  - An answer from Discord counts as yours only when you typed it yourself and you paired that conversation from a device you have confirmed. That device confirmation arrives with the next Fulcra update. Each Discord message can give one answer; answer a second question in a new message.
  - Answers from a terminal or a session are marked "answered by the operator", because Fulcra can't tell your typing from an agent's there. Even so, Fulcra checks that a person typed them: a terminal answer needs you to type the option number again at the prompt (it won't work when run by a script), and a session answer counts only if a message typed into that session after the question was shown names the option.
  - If you revoke the device you paired a Discord conversation from, that conversation is paused and its answers stop counting as yours.
  - Every new channel is announced at the top of the Inbox and in the daily digest, like a new device.
  - Approvals that start work always wait for your paired device.
- **Pause and Revoke.** In the Channels tab, **Pause** stops a channel showing or answering until you turn it back on. **Revoke** ends it for good.

For example: you're away from your desk and your Discord conversation shows _"1. [Now] Where should practice copies of our products live?"_ You reply "show 1", read the two options and their examples, and answer "option 2". The Inbox on your Mac now says the question was answered in Discord, and the project that asked is told your choice.

Phone alerts for urgent items (the title only, never the details) arrive once the Fulcra app offers notifications to plugins.

### Devices

An answer in the Inbox counts as yours only when a device you paired confirms it. Anything else on this computer that runs as your user can reach Fulcra's controls, so Fulcra doesn't treat that access as proof it's you.

- **Paired devices.** Each paired phone or computer keeps a private key that never leaves it. Where the device supports it, each use is confirmed with Touch ID or Face ID. The **Devices** tab lists each device, how its key is protected ("Protected by Touch ID", or "Protected by your login only"), when it was paired, and a **Revoke** button.
- **Without a paired device.** An answer is labelled "Answered by the operator", and the session that asked is told the same. Approvals that start work, such as putting a new version in front of customers, can't be answered at all until you confirm them on a paired device.
- **Every change is announced.** Each pairing and each revocation appears at the top of the Inbox and in the next daily digest.

For example: you pair your Mac. Later an alert reads _"A new device, iPhone, was paired at 21:04. Not you? Revoke it."_ If you didn't pair it, tap Revoke on your Mac, and that iPhone can no longer answer for you.

**Pairing is switched off in this build.** The Devices tab says "Pair a device after the next Fulcra update", and the controller refuses every pairing request until two things are true:

- this version of Fulcra is a release that allows pairing. That is built into the release itself; there is no setting or file that turns it on; and
- the Fulcra app on this computer can create and protect device keys, which the controller checks with the app directly.

No command-line or agent request, and no file written on this computer, can switch it on or pair a device. Opening a Discord pairing that could answer as you is switched off the same way.

**What will still be possible once pairing is on (stated plainly).** Answers you give on your paired device are signed by it. Claude sessions can't read Fulcra's control files. Codex sessions with full access, or another program running as you on this Mac, could still get around this, including by imitating a Discord message from you. Stronger protection comes when Fulcra can check your iPhone's hardware (needs an Apple Developer membership).

**Why it's off: the real exposure.** Fulcra's controls on your computer are reachable by any program running as your user. That includes AI agents working for you, and such a program can imitate the Fulcra app. If pairing were open to those controls, a program could pair a key of its own as your "first device", approve work in your name, and lock you out of undoing it, because every later change would need that device's signature. Until there's a safeguard that such a program can't imitate (a decision still open), pairing stays off. That's why nothing counts as your answer yet, and why approvals that start work wait.

**When pairing arrives:**

- Every later device must be approved on a device that's already paired.
- Every pairing and revocation is announced at the top of the Inbox and in the daily digest.

**Storage limits.** Each Inbox table has its own bound, a deliberate exception to counting everything in the shared journal capacity. The shared delivery journal still counts every answer sent to a session.

| Table                    | Holds                                     | Bound                 | At the bound                                                  |
| ------------------------ | ----------------------------------------- | --------------------- | ------------------------------------------------------------- |
| `cc_decisions`           | questions and their answers               | 5,000                 | new questions are refused, with a message saying so           |
| `cc_decision_history`    | every change to a question                | 25,000                | new questions and answers are refused, with a message         |
| `cc_decision_deliveries` | answers passed back to the asking session | 5,000                 | new answers are refused, with a message                       |
| `cc_digests`             | daily digests (derived)                   | newest 60 per project | the oldest are deleted as new ones are written; never refused |

At 90% of any bound the Inbox shows an attention item.

**Operator archive (not built yet).** The archive is meant to remove finished questions (answered, withdrawn, replaced or expired) older than 90 days, together with their history and delivery rows. This release does not ship an archive command. Until it does, rely on the 90% warning and the refusal message. Do not delete rows from the controller journal by hand: delivery rows are the record that stops an answer from being sent twice.

## Setup

You need the Fulcra app and host, and the Fulcra controller running on the same machine.

1. **Install the plugin** from a reviewed release. Keep the previous release, so you can roll back.
2. **Tell the plugin where things are**, in the host's launch environment. Either set one portable home, or set
   each place on its own:

   | Setting                    | What it points to                                                |
   | -------------------------- | ---------------------------------------------------------------- |
   | `ORCA_HOME`                | A portable Fulcra home. Every place below is derived from it.    |
   | `ORCA_CONTROLLER_HOME`     | The Fulcra controller's home.                                    |
   | `PASEO_HOME`               | The Fulcra host's home. The host usually sets this itself.       |
   | `ORCA_DAEMON_INSTALLATION` | The Fulcra host installation, used to check the host's password. |
   | `ORCA_OUTCOMES_DIR`        | The folder of published outcome records.                         |
   | `ORCA_TASKS_DIR`           | The folder of task working directories.                          |

   If a place is not set, the part that needs it says so and names the setting. Nothing falls back to a path on
   someone else's machine.

3. **Sign in to a tracker** (optional). In the controller folder on the host, run:

   ```
   node src/control/trackers-credential.mjs set github
   node src/control/trackers-credential.mjs set jira <your-site>.atlassian.net
   node src/control/trackers-credential.mjs set bitbucket
   ```

   The command asks for a read-only token with the input hidden. It stores it in the macOS Keychain, under the
   plugin's own name. If you installed the plugin under a different id, set
   `ORCA_TRACKERS_PLUGIN_ID` to that id first.

### For developers

Install the development dependencies listed in `package.json`. The plugin builds against the Fulcra host's own
plugin SDK (`@getpaseo/plugin` from the product repository), which is newer than the published package. Then:

- `npm test` typechecks the plugin, builds it and runs the unit tests.
- `node verify-ui.mjs <tooling-folder> <file>` runs the component tests with a folder that provides React DOM,
  jsdom and Testing Library.
- `node verify-controller-contract.mjs` runs the work map against the controller source beside this folder.
- `node verify-screens.mjs <tooling-folder>` renders each ready tab at desktop and phone size, dark and light, into
  `docs/screens/foundation/`, and fails if any capture shows personal data. It needs Playwright in the tooling folder.
- `node verify-sessions-screens.mjs <tooling-folder>` does the same for the step-through, with a fictional Claude
  and Codex session, into `docs/screens/sessions/`.

The detailed design notes are in [`docs/design-notes.md`](docs/design-notes.md).

## Privacy

- **Everything stays on your machine.** The plugin reads from the Fulcra controller and host on the same machine.
  The only outside calls are read-only requests to the trackers you sign in to.
- **No telemetry.** The plugin sends nothing about you or your work anywhere else.
- **Secrets stay in the operating system's credential store.** They never reach the app's screens, and they
  are never written to the plugin's files.
- **Nothing personal is stored or shown by accident.** One shared check (`shared/cc/refs.ts`) looks for personal
  paths, private host names, email addresses and tokens. Each part of the Command Centre applies it to the text it
  stores or publishes, and it runs on every screenshot used in this project's documentation.
- **Conversation text is private.** When you open a session, its messages are shown as plain text, and nothing is
  run or followed from them.

## Where data lives

| What                                     | Where                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Projects, seats, tasks and their history | The Fulcra controller's journal, in the controller home.                                                              |
| Sessions and their conversations         | The Fulcra host, in its home.                                                                                         |
| Published outcome records                | The outcomes folder.                                                                                                  |
| Tracker tokens                           | The macOS Keychain, under the plugin's own name. Windows and Linux follow with Fulcra's shared credential store.      |
| The last good view of each tab           | In the app's memory only, while it is open. It is used when Fulcra is slow to answer and is gone when the app closes. |
| Test results                             | The `runtime/` folder next to this file, created by `npm test`. It is not part of the release.                        |

## Command Centre walkthrough fixes

**Sessions** searches the saved session directory on the server, with 64 results per page. Use **Next sessions** to reach older idle conversations, or choose a project in **Organisation** and select **Step through** beside its session. For example, a quiet shop orchestrator remains reachable even when a hundred other conversations are saved.

**Inbox** folds held messages by sender, showing a count. Expand a sender to read each message's first-line subject; private paths, hostnames, addresses and tokens are removed before the subject is shortened. Opening a group does not mark messages read or release a hold.

A project's story opens at the top. On the next operator read, **Delivery** receives an explicit, recorded remit for projects that have never had an owner. Moving or ending that remit prevents it from being assigned again automatically; existing area ownership is preserved.

Inbox held messages show elapsed waiting time, such as “Waiting 2 days”. Sender groups are ordered by their oldest message, and each group shows its oldest messages first. Read-only cards say “Open in Fulcra”; a reply box appears only when replying is available.

**Changes** is visible beside Inbox. It groups open and recently merged pull requests by project. Choose **Open change view** to compare the architecture maps in the app. For example, an example shop can compare its checkout flow before and after a pull request. The repository must already have a workspace on the connected host. Older apps explain how to open Architecture map manually.

Recent merges use the merge event timestamp supplied by Trackers. Some existing connectors derive that event from the last update time; exact merge dates need the upstream tracker contract to carry that information. Missing merge timestamps are excluded.

The controller batches the session list's routing and pending worker-revocation reads. It preserves the original fields and does not change session control or provider settings.

## Portable Command Centre

The trusted host passes `ORCA_HOME` (normally `PASEO_HOME/command-centre`). Run `node dist/tools/init-config.mjs` from the built controller package on first setup; both services read that root's private `config.json`. For example, name the local host "Desk" and add "Studio" to the remote hosts list; the UI uses those names, with no built-in machine identities. A new installation has no selected task until one is chosen.

Run `npm run verify:portable` to check source for machine-specific values. Controller dependencies belong to its own package and are bundled by `npm run build:portable`. Authentication and activation fail closed until the trusted host integration is connected.

### Clean finished jobs

Settings → Clean-up previews space that can be freed after a pull request is merged or
all of a job's sessions are archived. Check the list, then choose **Confirm clean-up**.
For example, keep finished files for 7 days, then remove working copies and dependencies
while retaining the branch, reports, inputs and evidence. Jobs with unsaved or unpushed
work stay intact and explain what needs attention. Automatic clean-up starts off ("never");
saving a number of days turns it on. Loose build folders and caches are kept; outside
a Git working copy, only dependency folders (`node_modules`) are removed. With “never”,
a manual preview still uses the default seven-day retention. Release candidates are
listed for review and are never removed here.

### Trusted controller hooks (integration pending)

The distribution bundles `index.host.js` as a trusted V1.1 contribution. It checks
journal attempts, prompt payloads, permissions, delegation and quota before native
work. For example, changing a queued instruction's model or a supervisor's human
input fence refuses the instruction rather than submitting it under stale authority.
The five-hook catalog report must match this plugin and the current host boot.

This branch does not enable the controller: the compatible published SDK and V4's
private authenticated transport are still required. Management integration remains
phase B. Existing patch tooling is retained wherever full replacement parity has
not been demonstrated; it is not part of the portable bundle.

For source-build verification, run `tools/build-host-test.mjs PRODUCT_SOURCE OUTPUT`
under the heavy-work lock, then use `tools/host-test-loader.mjs` and
`tools/host-test-config.mjs` with Node's per-file runner. Set `FULCRA_TEST_PRODUCT`
to that product source and `FULCRA_TEST_HOST` to the output fixture. The builder
creates an output-local dependency symlink for internal CommonJS imports; remove
it and the fixture after verification. This mechanism is test-only and makes no
published-SDK compatibility claim.

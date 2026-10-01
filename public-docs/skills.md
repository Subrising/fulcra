---
title: Orchestration skills
description: Reusable workflows for handing off tasks, getting a second opinion, and planning with multiple agents.
nav: Skills
order: 33
category: Orchestration
---

# Orchestration skills

Skills give your agents reusable instructions for delegation, handoffs, and reviews. You can also [ask for these workflows directly](/docs/orchestration-workflows) without installing skills.

| Skill              | Use it to                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `/fulcra`          | Coordinate primes, project orchestrators and persistent sessions, native reports, isolated jobs and account usage. |
| `/paseo`           | Look up how to manage agents, workspaces, schedules, and heartbeats.                                               |
| `/paseo-handoff`   | Transfer a task and its context to another agent.                                                                  |
| `/paseo-committee` | Get two independent analyses of a difficult problem.                                                               |
| `/paseo-advisor`   | Get a second opinion on your current work.                                                                         |

## Installation

- **In Fulcra:** Open **Settings → your host → Agents → Orchestration skills** and include **fulcra** in the skills you install on that host. Repeat on each host where your agents run. **All** includes new bundled skills; an existing custom selection keeps your choices.
- **From the terminal:** The upstream Paseo skills remain available through `npx skills add getpaseo/paseo`. That upstream catalog does not contain Fulcra's skill; install **fulcra** from the app's bundled catalog.

Use the same settings card to update or uninstall skills. The host also refreshes selected installed skills on startup. Fulcra installs its skill in `~/.claude/skills/fulcra` for Claude and `~/.agents/skills/fulcra` for Codex's shared discovery. It does not install a second copy in `~/.codex/skills`, so Codex lists `/fulcra` once. Start a new provider session if its skill catalog was loaded before installation.

## `/fulcra`, Working Organization

Fulcra's skill teaches agents to resolve the existing prime → project orchestrator → sessions hierarchy, retain saved chats, stage each editing job in its own worktree, and wait on native events. It covers reports to the recorded parent and owning prime, held inbox messages, configured accounts and session-bound usage. Installing it does not enroll a session or grant controller authority; it uses the scoped tools your host exposes.

> /fulcra continue this project's existing team and report the checked result to its owning prime

The bundled Paseo skills remain at upstream v0.10.2.

## `/paseo`, Paseo Reference

The foundational reference used by the other skills. It teaches agents to check your [agent profiles and their notes](/docs/agent-profiles#guide-delegation-with-notes) before delegating, then apply the selected launch settings. If no profile fits, it directs them to discover available providers and models and tell you about the fallback.

> /paseo show me how to create an agent in a workspace with worktree isolation

## `/paseo-handoff`, Task Handoff

Transfer the current task with a briefing: relevant files, progress, decisions, constraints, and acceptance criteria. The skill checks profiles before choosing the receiving agent; you can name the profile you want.

> /paseo-handoff hand off the auth fix to an implementation agent in its own worktree

The receiving agent gets the context it needs to continue. Ask for a separate worktree when it should edit independently.

## `/paseo-committee`, Committee Planning

Get two agents to analyze a difficult problem independently. The skill checks profile notes for planning and analysis, preferring different provider families when possible.

> /paseo-committee why are the websocket connections dropping under load?

Committee members return analyses without editing files. The main agent synthesizes their plans, implements the solution, and sends the diff back for review.

## `/paseo-advisor`, Advisor

Get another agent's judgment on a design, diff, or question. The skill chooses a profile whose notes fit the work, or uses the profile you name.

> /paseo-advisor did I miss anything in this migration plan?

The advisor returns a second opinion without editing files.

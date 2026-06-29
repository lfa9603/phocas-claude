# phocas-claude

The company-wide Claude base for Phocas engineers, distributed as the `phocas-base` plugin.

## What this is

`phocas-claude` is a single Claude Code plugin that gives every engineer the same sensible defaults on install. Once installed, Sonnet becomes the default model, a shared `CLAUDE.md` carries model-routing and session-hygiene rules, four skills arrive pre-wired to the right model for each step, and a status-bar nudge shows live session cost and an approximate weekly total. The design principle is cost-conscious by default, invisible in practice: engineers do not need to think about any of it to benefit from it.

## What's inside

```
.claude-plugin/
  plugin.json          Plugin manifest — name, version, author, homepage.
  marketplace.json     Marketplace entry so the plugin can be found and installed
                       via /plugin install phocas-base@phocas.

CLAUDE.md              The base context file: model-routing rules, session-hygiene
                       guidance, and a reference to the four shared skills. Merged
                       into ~/.claude/CLAUDE.md on install.

settings/
  settings.json        Sets claude-sonnet-4-6 as the default model and wires the
                       statusLine command to the cost-nudge script.

statusline/
  statusline.sh        Bash script that reads the statusLine JSON on stdin and
                       prints model, live session cost, and an approximate
                       week-to-date total. Requires jq.

skills/
  read-jira-ticket/    Fetches a Jira ticket, its acceptance criteria and linked
    SKILL.md           PRs. Runs on Haiku — cheap, read-only.
  create-feature-branch/
    SKILL.md           Names and checks out a branch from a ticket key. Runs on
                       Haiku — mechanical git work.
  plan-ticket/
    SKILL.md           Orchestrates Haiku (fetch + branch) and Opus (plan) to
                       produce an implementation plan from a ticket. Runs on Sonnet
                       as orchestrator.
  review-pr/
    SKILL.md           Reviews a PR for correctness, conventions, and test
                       coverage. Runs on Sonnet.
  ai-observability/
    SKILL.md           Runs scripts/observability/ai-resource-stats.ts and reports
                       agent/skill usage, success rates and daily volume from the
                       local ledger.

hooks/
  hooks.json           SessionStart / PostToolUse / UserPromptSubmit hooks that
                       derive the Jira ticket from the current git branch
                       (FS-XXXX-slug), inject it as session context, and append a
                       {ts,session,ticket,branch,event} line to
                       ~/.claude/observability/session-tickets.jsonl. Deduped — one
                       line per ticket change, not per command. Requires bash on PATH
                       (Git Bash on Windows).

agents/
  session-ticket-mapper.md
                       Groups sessions per Jira ticket from the session-tickets
                       ledger, enriched from invocations.jsonl (joined on session).
                       Defaults to incremental (sessions since its last run via a
                       self-maintained watermark). Surfaced as /session-ticket-map.

commands/
  session-ticket-map.md  Slash command wrapper for the mapper agent.

scripts/
  observability/
    ai-resource-stats.ts  Pure-Node (no deps) transcript parser that builds
                          ~/.claude/observability/invocations.jsonl. Run via npx tsx.

docs/
  cost-governance.md   Why this base exists and how it addresses the two root
                       causes of high spend.
  claude-md-hierarchy.md
                       How the three-level CLAUDE.md model works.
  cost-visibility.md   What the status bar is, what it is not, and where real
                       cost tracking belongs.
  multi-tool.md        Generalising the base across Claude, Cursor, OpenAI/Codex
                       and Copilot — shared context via AGENTS.md and hybrid cost
                       governance.

examples/
  repo-CLAUDE.md.example
                       A realistic repo-level CLAUDE.md for an fs-app repo,
                       showing what a team adds on top of the base.
```

## Install

Install from the Phocas marketplace:

```
/plugin install phocas-base@phocas
```

On install, the plugin should:

1. Merge `CLAUDE.md` into `~/.claude/CLAUDE.md`.
2. Merge `settings/settings.json` into `~/.claude/settings.json`.
3. Copy `statusline/statusline.sh` to `~/.claude/phocas/statusline.sh` and make it executable (`chmod +x ~/.claude/phocas/statusline.sh`).

The `settings.json` statusLine command is `bash $HOME/.claude/phocas/statusline.sh`. If the status bar does not appear, replace `$HOME` with an absolute path — Claude Code does not expand a bare `~` in this field. `jq` must be available on `PATH` for the status line to work.

## The three-level model

Claude Code merges `CLAUDE.md` files from three levels: user (`~/.claude/CLAUDE.md`), repo (`./CLAUDE.md`), and subdirectory (`./src/<area>/CLAUDE.md`). The base context in this plugin lives at the user level and is never edited directly. Repo teams add a `./CLAUDE.md` that states only what is different for their codebase. Engineers working in a concentrated area can add a subdirectory-level file for context that would otherwise pollute the whole session. Each level adds; it does not replace. See `docs/claude-md-hierarchy.md` and `examples/repo-CLAUDE.md.example` for a worked example.

## Cost philosophy

The status bar is a behavioural nudge, not a cost-accounting system. It shows the current model, live session spend drawn from the statusLine `cost.total_cost_usd` field, and an approximate local week tally kept in `~/.claude/phocas/week/`. This is enough to change a habit — it is not accurate or complete enough to allocate spend or report to leadership. Authoritative per-user cost tracking belongs at the API boundary, not on the laptop. See `docs/cost-visibility.md` for the full reasoning.

## Session → ticket observability

On install, the `hooks/hooks.json` hooks activate automatically (no manual settings merge needed). They derive the Jira ticket key from your current git branch name (`FS-XXXX-...`), inject it as session context so Claude knows which ticket you're on, and record it to a per-user ledger at `~/.claude/observability/session-tickets.jsonl`:

- **SessionStart** — records the ticket at session start.
- **UserPromptSubmit** — catches a branch you switched in your own terminal, on your next message.
- **PostToolUse / Bash** — catches a branch switched via a command in-session.

All three are deduped against a state file (`<git-dir>/claude-jira-ticket`), so they only speak up — and write a ledger line — when the ticket actually changes, never per command.

The **`session-ticket-mapper`** agent (`/session-ticket-map`) then groups sessions per ticket, joining `session-tickets.jsonl` to `invocations.jsonl` (built by the `ai-observability` skill's script) on the `session` field. The two ledgers are designed to join on that key. The mapper runs incrementally by default — only sessions since its last run.

**Requirements:** the hooks run with `"shell": "bash"`, so **bash must be on PATH** (Git Bash on Windows). On a PowerShell-only Windows setup the hooks silently no-op. The `ai-observability` script needs Node (it's run via `npx tsx`, no install). These features write only to the user's own `~/.claude/observability/` — no shared/network state.

## Status

This is an early scaffold at v0.2.0, currently in planning. The intention is to gather feedback from a small group of engineers before wider rollout.

## Background

The design rationale lives in Confluence: [AI Cost Governance: Centralised Visibility & Smart Allocation for 70 Engineers](https://helpphocassoftware.atlassian.net/wiki/x/CYANRgE).

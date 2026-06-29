# Phocas AI Base Context

This file is the Phocas-wide Claude base. It is distributed via the `phocas-base` plugin to `~/.claude/CLAUDE.md`. Do not edit it locally — extend it at the repo or feature level (see `docs/claude-md-hierarchy.md`).

## Model routing
Route work to the right model for the task. These are defaults — override in your repo `CLAUDE.md` if a project has genuinely different needs.

- **Haiku**: fetching Jira tickets, reading files to understand structure, listing repos, git operations (create branch, status, log), diff summaries, classification tasks, one-shot lookups
- **Sonnet**: routine coding, PR reviews, debugging, E2E test writing, refactors, PR descriptions — the everyday workhorse
- **Opus**: architecture planning, complex cross-repo features, designing something new, hard reasoning where quality matters more than cost
- **Fable**: explicit opt-in only. Before switching to Fable, state why in a comment. Do not use Fable as a default for any task type.

When spawning sub-agents via Task, specify the model explicitly. Note: the Task `model` parameter accepts the aliases `haiku`, `sonnet`, and `opus` only — this enforces model choice for skill-driven sub-tasks, not for your interactive session.

## Session hygiene
- Run `/compact` or `/clear` between unrelated sub-tasks
- Start a new session per Jira ticket where practical
- Scope file reads to the relevant module — avoid loading an entire repo unless the task genuinely requires cross-repo context

## Phocas shared skills
The following skills ship with `phocas-base` and are pre-wired to the correct model. Prefer these over manual equivalents:
- `read-jira-ticket`     → fetches ticket, acceptance criteria, linked PRs (Haiku)
- `create-feature-branch` → names branch from ticket, checks out locally (Haiku)
- `plan-ticket`          → produces an implementation plan from a Jira ticket (Haiku fetch + Opus plan)
- `review-pr`            → reviews a PR against Phocas standards (Sonnet)

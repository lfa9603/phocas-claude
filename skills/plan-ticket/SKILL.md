---
name: plan-ticket
description: Turn a Jira ticket into a scoped implementation plan with file targets. Use when an engineer wants to go from a ticket key to a plan. Routes cheap data-gathering to Haiku and the planning itself to Opus, so it is Opus-quality at a fraction of the cost.
model: claude-sonnet-4-6
argument-hint: <JIRA-TICKET-KEY>
---

# plan-ticket

Orchestrate a cost-aware path from a Jira ticket to an implementation plan. The orchestrator runs on Sonnet and delegates each step to the right model via the Task tool, so the engineer never thinks about model selection.

Steps:
1. **Fetch the ticket** — call Task with `model=haiku` (use the `read-jira-ticket` skill) to pull the ticket, acceptance criteria, and linked PRs. Approx cost: ~$0.001.
2. **Create the branch** — call Task with `model=haiku` (use the `create-feature-branch` skill) to name and check out the branch. Approx cost: ~$0.001.
3. **Generate the plan** — call Task with `model=opus` to scan the relevant repo area and produce an implementation plan with concrete file targets and an approach. Approx cost: ~$2–5 depending on codebase size.

Total: ~$2–5, versus $15–30 if Opus ran every step. Note that the Task `model` parameter accepts only the aliases `haiku`, `sonnet`, and `opus`.

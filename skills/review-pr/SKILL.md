---
name: review-pr
description: Review a pull request against Phocas standards. Use when an engineer wants a PR reviewed for correctness, conventions, and test coverage. Routine review work — runs on Sonnet.
model: claude-sonnet-4-6
argument-hint: <PR-URL-or-number>
---

# review-pr

Review the named pull request against Phocas conventions. This is routine review work, so it runs on Sonnet — not Opus.

Steps:
1. Fetch the PR diff and description.
2. Review for correctness, adherence to repo conventions, error handling, and test coverage.
3. Return concrete, line-referenced feedback grouped by severity (blocking / suggestion / nit). Do not approve or merge — leave the decision to the engineer.

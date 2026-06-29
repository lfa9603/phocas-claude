---
name: create-feature-branch
description: Create and check out a local feature branch named from a Jira ticket. Use after reading a ticket, when the engineer is ready to start work. Mechanical git work — runs on Haiku.
model: claude-haiku-4-5-20251001
argument-hint: <JIRA-TICKET-KEY>
---

# create-feature-branch

Create a local branch for the given ticket and check it out. This is mechanical git work, so it runs on Haiku.

Steps:
1. Derive a branch name from the ticket key and a slugified short title (e.g. `FS-5180-fix-display-names`).
2. Create the branch off the current default branch and check it out locally.
3. Confirm the branch name and that the working tree is clean.

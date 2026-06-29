---
name: read-jira-ticket
description: Fetch a Jira ticket with its acceptance criteria and linked PRs. Use when an engineer references a ticket key and wants its details. Cheap, read-only work — runs on Haiku.
model: claude-haiku-4-5-20251001
argument-hint: <JIRA-TICKET-KEY>
---

# read-jira-ticket

Fetch the named Jira ticket and summarise it for downstream work. This is deliberately a Haiku skill: it is read-only data-gathering with no reasoning, so it should never burn an expensive model.

Steps:
1. Resolve the ticket key from the argument (e.g. `FS-5180`).
2. Fetch the ticket: summary, description, acceptance criteria, status, assignee, and any linked pull requests.
3. Return a compact summary the calling session or skill can use — do not editorialise or propose solutions here.

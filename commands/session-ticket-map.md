---
description: Map your Claude sessions to Jira tickets (incremental since last run by default).
argument-hint: "[FS-1234] [--days N] [--all] [--reset] [--write]"
---

Use the **session-ticket-mapper** agent to produce a map of sessions grouped per Jira ticket.

Pass `$ARGUMENTS` straight through to the agent. With no arguments it runs incrementally — only sessions since its last run, using its self-maintained watermark. A ticket key restricts to that ticket; `--days N` / `--all` are ad-hoc windows; `--reset` clears the watermark; `--write` also saves `session-ticket-map.md`.

Launch the `session-ticket-mapper` agent now with the provided arguments and present its report.

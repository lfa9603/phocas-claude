---
name: session-map-infer-tickets
description: Infer Jira tickets for sessions that are missing from the authoritative ticket ledger, using the branch-derived ticket on the usage ledger's records. Regex/lookup classification — runs on Haiku. Internal step of the session-ticket-mapper orchestrator; output is always kept separate from authoritative counts. Not for direct use.
model: claude-haiku-4-5-20251001
argument-hint: "<RUN_DIR>"
---

# session-map-infer-tickets

Third step of the `session-ticket-mapper` flow — the **secondary, best-effort** layer. For sessions seen in `usage.jsonl` that are NOT ledger-attached, attribute a ticket from the `ticket` field on the usage records (derived from `gitBranch`). This is a lookup/classification step, so it runs on Haiku. Inferred results are never merged into the authoritative counts.

`usage.jsonl` lives under `~/.claude/observability/` (resolve `~`; no `jq` — use `python3`).

## Inputs
`$ARGUMENTS` is the `RUN_DIR`. Read `$RUN_DIR/window.json` for `since_ms` and `project_filter`; read `$RUN_DIR/ledger-map.json` for `attached_sessions` (the set to exclude).

## Steps
1. Load `usage.jsonl`, filter `ts >= since_ms` (and `project_filter` if set). Drop any session already in `attached_sessions`.
2. For each remaining session, attribute a ticket from the non-null `ticket` field on its records (most frequent; tie-break: earliest). A `ticket` may also be re-derived from the `branch` field via `[A-Z]{2,}-\d+` if needed. Sessions whose records have no branch ticket are left unattributed (counted in `no_ticket_sessions`).
3. **Write** `$RUN_DIR/inferred.json`:
   ```json
   {"inferred": [
      {"ticket":"FS-5180","sessions":[{"session":"...","project":["fs-app"],
        "active":"...","cost":0.0,"models":[],
        "matched_branch":"FS-5180-..."}]}],
    "no_ticket_sessions": 0}
   ```
   `no_ticket_sessions` = usage sessions with no ticket at all (ledger or inferred), for the coverage notes.
4. **Return** a one-line count (inferred tickets, inferred sessions, no-ticket sessions). Every inferred row must stay caveated downstream — never present it as authoritative.

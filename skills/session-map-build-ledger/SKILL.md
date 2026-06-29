---
name: session-map-build-ledger
description: Parse the session-tickets and usage JSONL ledgers, build the authoritative ticket→sessions map, and enrich each session (project, time span, USD cost, token totals, models used). Deterministic python aggregation — runs on Haiku. Internal step of the session-ticket-mapper orchestrator; not for direct use.
model: claude-haiku-4-5-20251001
argument-hint: "<RUN_DIR>"
---

# session-map-build-ledger

Second step of the `session-ticket-mapper` flow. Build the **authoritative** map from the two ledgers and write it as structured JSON for the render step. This is deterministic aggregation, so it runs on Haiku — do the work in python, never eyeball the JSONL.

Both ledgers live under `~/.claude/observability/` (resolve `~` with `os.path.expanduser`; on this machine that is `C:\Users\LorenzoFasano`). Both are JSONL (one object per line; skip blank lines). **No `jq`** — use `python3`.

## Inputs
`$ARGUMENTS` is the `RUN_DIR`. Read `$RUN_DIR/window.json` for `since_ms`, `ticket_filter`, `project_filter`.

## Data sources
1. **`session-tickets.jsonl`** (source of truth) — fields: `ts` (epoch ms), `session` (UUID), `ticket` (e.g. `FS-5198`), `branch`, `event` (`SessionStart`|`BranchChange`).
2. **`usage.jsonl`** (enrichment) — one record per assistant message. Fields: `ts` (epoch ms), `project` (slug), `session`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`, `branch`, `ticket`.

Join key between the two is **`session`**.

### Pricing (USD per token)
Cost is not stored in the ledger — derive it here. Match the model id by substring; cache read = 0.1× input, cache write 5m = 1.25× input, cache write 1h = 2× input.

| Model substring | Input $/1M | Output $/1M |
|---|---|---|
| `fable` | 10 | 50 |
| `opus` | 5 | 25 |
| `sonnet` | 3 | 15 |
| `haiku` | 1 | 5 |

```
cost = input*in + output*out
     + cacheRead*in*0.1 + cacheWrite5m*in*1.25 + cacheWrite1h*in*2.0
```
A record whose model matches no row (e.g. `<synthetic>`) costs `$0`.

## Steps
1. Load both ledgers in python; filter records to `ts >= since_ms`. If `ticket_filter` is set, restrict to that ticket. If `project_filter` is set, restrict enrichment to that project slug. A session is "in window" if any of its records is.
2. If `session-tickets.jsonl` is missing or empty, set `"ledger_missing": true` in the output and proceed (the render step will fall back to inference-only, clearly labelled).
3. **Build the authoritative map:** group `session-tickets.jsonl` records by `ticket`. For each ticket collect distinct `session` UUIDs and the branch(es) seen. Every ledger-attached session is listed under its ticket.
4. **Enrich each session** from `usage.jsonl` (match on `session`): project slug(s); activity window (min/max `ts` → dates + duration); message count; total USD cost (sum of per-record cost via the pricing table above); token totals (input, output, cache); models used. A ledger-attached session with no usage rows is normal — include it with enrichment marked `"no usage data"`.
5. **Write** `$RUN_DIR/ledger-map.json`:
   ```json
   {"ledger_missing": false,
    "earliest_ledger_ts": 0,
    "attached_sessions": ["<uuid>", ...],
    "tickets": [
      {"ticket": "FS-5198", "branches": ["FS-5198-..."], "cost": 68.36,
       "sessions": [{"session":"...","project":["fs-app"],"active":"Jun 28-29 (2d)",
                     "messages":186,"cost":32.65,"input_tokens":56700,
                     "output_tokens":307200,"cache_tokens":30300000,
                     "models":["opus"],"no_data":false}]}],
    "usage_sessions_total": 0,
    "total_cost": 0}
   ```
   Order tickets by total cost (desc); order sessions within a ticket by cost (desc).
6. **Return** a one-line count summary (tickets, ledger-attached sessions, window) for the orchestrator to relay.

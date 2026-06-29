---
name: ai-observability
description: Generates an observability report on Claude Code cost — cost per session and total spend aggregated per Jira ticket — across this user's projects. Reads a persistent ledger at ~/.claude/observability/usage.jsonl built incrementally from Claude Code transcripts (per-message token usage priced against current model rates). Use when investigating how much a ticket or session cost, where AI spend is concentrated, cost-by-model breakdowns, or daily spend trends. Triggers on "observability", "ai cost", "how much did X cost", "cost per session", "cost per ticket", "spend by ticket", "ai usage", "ai stats", "show me my ai cost".
---

# AI Cost & Ticket Report

The bundled `ai-resource-stats.ts` script **computes data only** — it parses the transcripts, prices each message, and prints a single JSON `ReportData` object to stdout. **You (this skill) own all presentation**: you parse that JSON and render the markdown tables yourself. The script never emits tables. It is pure Node built-ins (no dependencies) and maintains a persistent ledger at `~/.claude/observability/usage.jsonl`, so subsequent runs only process new transcript data.

You render two primary tables and two secondary ones from the JSON:
1. **Cost per Jira ticket** — total spend grouped by ticket tag (e.g. `FS-5198`), with session counts.
2. **Cost per session** — what each session cost, broken down by model and cache usage.

Plus secondary **cost by model** and **daily cost** tables.

## JSON shape (stdout)

A single object — see the `ReportData` / `SessionData` / `TicketData` interfaces in the script for the authoritative definition. All numbers are raw (cost in USD, tokens as counts, timestamps as epoch ms); model ids and project slugs are unabbreviated.

```jsonc
{
  "windowDays": 30, "sinceMs": 1782…, "scope": "all projects", "repoFilter": "on",
  "totalCost": 651.19, "recordsInWindow": 4414, "ledgerTotal": 4520,
  "excludedProjects": [ { "slug": "C--Users-…", "cwd": "C:\\Users\\…", "records": 52 } ],
  "tickets":  [ { "ticket": "FS-5180", "sessions": 5, "cost": 151.9,
                  "inputTokens": …, "outputTokens": …, "cacheTokens": …, "lastTs": … } ],
  "sessions": [ { "session": "<uuid>", "project": "C--stash-fs-app", "ticket": "FS-5180",
                  "models": ["claude-fable-5"], "messages": 275,
                  "inputTokens": …, "outputTokens": …, "cacheReadTokens": …,
                  "cacheWriteTokens": …, "cost": 108.43, "firstTs": …, "lastTs": … } ],
  "byModel":  [ { "model": "claude-opus-4-8", "messages": …, "cost": … } ],
  "daily":    [ { "day": "2026-06-29", "cost": … } ],
  "diagnostics": { "filesTracked": …, "newRecords": …, "filesProcessed": …,
                   "unparseable": …, "modelsSeen": [{ "model": …, "count": … }],
                   "unpricedModels": [] }
}
```

`tickets`, `sessions`, and `byModel` are pre-sorted by cost descending; `daily` ascending by day. Format the numbers when rendering: USD to 2–4 dp, tokens as K/M, timestamps to dates, model ids shortened (`claude-opus-4-8` → `opus`), project slugs trimmed (`C--stash-fs-app` → `fs-app`), and a "% of total" column from `cost / totalCost`.

## How cost is computed

Each assistant message in a transcript carries a `usage` block (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` with a 5m/1h breakdown) and a `model`. The script prices each message against the current Anthropic rates:

- Base input/output per model (Opus / Sonnet / Haiku / Fable).
- Cache **read** = 0.1× input rate; cache **write** = 1.25× input (5-minute TTL) or 2× input (1-hour TTL).

Token counts are stored raw in the ledger; cost is derived at report time, so a pricing change re-prices the whole history without a `--rebuild`. If a new model appears with no pricing entry, it counts as `$0` and is listed in `diagnostics.unpricedModels` — surface that and update the `PRICING` table in the script.

## How sessions map to Jira tickets

Each session is counted **in full** against a single ticket — its entire cost, not a per-message split. This matches the common workflow where the first prompt asks Claude to cut a branch from `main` and check it out: those early "create the branch" messages happen on `main`, but the whole session still belongs to the branch it switched to.

A session's ticket is resolved via:
1. The authoritative `~/.claude/observability/session-tickets.jsonl` ledger written by the branch hooks (preferred — its last entry for the session wins).
2. Otherwise the most-recent Jira branch the session checked out, from the `gitBranch` field on the transcript events, matched against `[A-Z]{2,}-\d+`.
3. Otherwise `(untracked)` — a session that never left `main` / a non-Jira branch.

## Workflow

1. **Resolve the script path.** It ships inside this plugin at `scripts/observability/ai-resource-stats.ts`. Prefer the plugin-root env var; fall back to a search under the plugins cache:

   ```bash
   SCRIPT="${CLAUDE_PLUGIN_ROOT:-}/scripts/observability/ai-resource-stats.ts"
   [ -f "$SCRIPT" ] || SCRIPT=$(find "$HOME/.claude/plugins" -path '*phocas*/scripts/observability/ai-resource-stats.ts' 2>/dev/null | head -1)
   echo "$SCRIPT"
   ```

2. **Determine flags.** If the user passed `$ARGUMENTS`, use that. Otherwise default to `--all-projects --days 30` — cross-project view, last month.

3. **Run the script** with `tsx` (fetched on demand via npx; no install needed) and capture stdout, which is a single pure-JSON document (diagnostics are carried inside it, not on stderr):

   ```bash
   npx -y tsx "$SCRIPT" --all-projects --days 30
   ```

   Parse the stdout as JSON. Do not paste it to the user — it is input data, not the artifact.

4. **Render and present**, in this order:
   - **A 2–3 sentence interpretive header**: total cost in the window (`totalCost`), the top ticket by spend, and anything notable (a single session dominating a ticket, a spend spike in `daily`, a non-empty `diagnostics.unpricedModels`).
   - **The markdown tables you build from the JSON**: *Cost per Jira ticket*, *Cost per session*, then *Cost by model* and *Daily cost*. Suggested columns:
     - Ticket table: `Ticket | Sessions | Cost | % of total | Input | Output | Cache | Last active`
     - Session table: `Session (8-char) | Ticket | Project | Models | Msgs | Input | Output | Cache | Cost | Active`
     - If `excludedProjects` is non-empty, add a short *Excluded non-repo projects* note.
   - **A caveat line only if** `diagnostics.unpricedModels` is non-empty — those messages counted as $0, so the total is understated.

5. **If the user asked a specific question** (e.g. "how much did FS-5198 cost?"), answer it directly from the JSON — you don't have to render every table.

## Common flag combinations

| Goal | Flags |
|---|---|
| All projects, last 30 days (default) | `--all-projects --days 30` |
| Specific project only | `--project <slug>` (e.g. `C--stash-fs-app`) |
| Current project only (cwd auto-detected) | _(omit `--all-projects`)_ |
| Longer window | `--days 90` |
| Wipe and rebuild the ledger | `--rebuild` |

## How to read the data

- **`tickets`** is the primary signal — where spend is concentrated. The `(untracked)` ticket is sessions with no Jira branch (e.g. work on `main` or scratch repos).
- **`sessions`** is sorted by cost. A single long session can dominate a ticket's total.
- **Cache tokens** are usually the largest token bucket but cheap (read = 0.1× input) — high cache with low cost is expected and healthy.
- **`byModel`** shows where Fable/Opus spend goes vs cheaper Sonnet/Haiku.
- **`excludedProjects`** is populated when the repo filter drops scratch directories; re-run with `--include-non-repos` to keep them.

## Companion: session→ticket mapping

This plugin's **`session-ticket-mapper`** agent produces a richer per-ticket → per-session map (branches, resources, time spans). Use it when the question is "what work happened under ticket X" rather than "what did it cost".

## What you do NOT do

- Re-parse transcripts yourself — the script's JSON is authoritative.
- Paste the raw JSON to the user — it is input data. Render the tables from it.
- Pad with disclaimers about the cost being "approximate" — state the one real caveat (unpriced models, if any) and move on.

## Arguments

`$ARGUMENTS` — Optional flag string passed through to the script verbatim (e.g. `--days 7`, `--project C--stash-phocas`, `--rebuild --days 90`).

---
name: session-map-render-report
description: Synthesise the final session→ticket markdown report from the precomputed ledger map and inferred data. The one prose-judgment step of the flow — runs on Sonnet. Internal step of the session-ticket-mapper orchestrator; not for direct use.
model: claude-sonnet-4-6
argument-hint: "<RUN_DIR>"
---

# session-map-render-report

Fourth step of the `session-ticket-mapper` flow. Turn the computed JSON into a readable report. This is the only step that writes prose around data, so it runs on Sonnet — every preceding step ran on Haiku, and the numbers are already computed, so this stays cheap. Do not recompute anything; render what the data files contain.

## Inputs
`$ARGUMENTS` is the `RUN_DIR`. Read `$RUN_DIR/window.json`, `$RUN_DIR/ledger-map.json`, and `$RUN_DIR/inferred.json`.

## Output shape
Lead with a **2–3 sentence summary**: how many tickets, how many ledger-attached sessions, the total cost across them (`total_cost` from `ledger-map.json`), the resolved window, and anything notable (e.g. "the ticket ledger only has data since <date> — older sessions appear only in the inferred section", or "one session accounts for most of the spend"). If `ledger_missing` is true, say so plainly and present inference-only, labelled as such.

Then:

### Sessions per ticket (ledger-attached)
For each ticket (ordered by total cost, descending):

> **FS-5198** — N session(s) · $68.36 · branch `FS-5198-...`
> | session | project | active | cost | models | input / output / cache |
> |---|---|---|---|---|---|
> | `348cd56e…` | fs-app | Jun 28–29 (2d) | $32.65 | opus | 56.7K / 307.2K / 30.3M |

Use short 8-char session prefixes. Order sessions within a ticket by cost (descending). Format USD as the ledger-map provides it ($X.XX); abbreviate tokens (K/M). A session marked `no_data: true` has no usage rows — show `—` for cost/tokens.

### Inferred (not ledger-attached)
Same table shape, every row caveated as inferred from prompt text. If there is nothing useful, write `None surfaced.`

### Coverage notes
- The resolved window (from `window.json`), and for default incremental runs note that the watermark will advance (the orchestrator's final step reports the actual old → new).
- How many `usage.jsonl` sessions had no ticket at all (`no_ticket_sessions`).
- The earliest ledger `ts` (`earliest_ledger_ts`) so the reader knows the ledger horizon.
- Anything limiting confidence (transcripts not ingested, ambiguous inference, unpriced models counting as $0). One line — do not pad with "directional data" disclaimers.

## Steps
1. Render the report per the shape above.
2. **Write** it to `$RUN_DIR/report.md`.
3. **Return** the report verbatim (the orchestrator presents it and, if `write` is set in `window.json`, copies it to `session-ticket-map.md` in the cwd).

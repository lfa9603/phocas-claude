---
name: session-map-resolve-window
description: Resolve the time window and watermark for a session→ticket mapping run. Reads the mapper's self-maintained state file, parses the run flags, and writes the resolved window contract to the run dir. Mechanical file-read + arithmetic — runs on Haiku. Internal step of the session-ticket-mapper orchestrator; not for direct use.
model: claude-haiku-4-5-20251001
argument-hint: "<RUN_DIR> [FS-1234] [--days N] [--all] [--reset] [--project slug] [--infer] [--write]"
---

# session-map-resolve-window

First step of the `session-ticket-mapper` flow. Resolve "what window does this run cover" and persist it so the downstream leaf skills all agree. This is mechanical file-read + arithmetic, so it runs on Haiku.

State file: `~/.claude/observability/session-ticket-mapper.state.json`
(resolve `~` with `os.path.expanduser` — on this machine that is `C:\Users\LorenzoFasano`).
Shape: `{"last_run_ts": <epoch ms>, "last_run_iso": "<UTC ISO8601>"}`. Absent ⇒ first run.

There is **no `jq`** on this machine — use `python3` for all parsing.

## Inputs
The first token of `$ARGUMENTS` is the **run dir** (`RUN_DIR`) created by the orchestrator; the rest are the mapper flags passed through verbatim.

## Steps
1. **Handle `--reset` first.** If `--reset` is present: zero/delete the state file, write `$RUN_DIR/window.json` with `{"mode":"reset"}`, report the cleared state in one line, and **stop** — do not resolve anything else.
2. **Resolve the lower bound `since` (epoch ms):**
   - Default (no time arg) → `since = last_run_ts` from state, or `0` if state is missing (first run = all history). `mode = "incremental"`.
   - `--days N` → `since = now_ms - N*86400000` (state ignored). `mode = "days"`.
   - `--all`, or a specific ticket key with no `--days` → `since = 0` (state ignored). `mode = "all"` (or `"ticket"`).
   - Capture `now_ms` once via `date +%s%3N`.
3. **Write the window contract** to `$RUN_DIR/window.json`:
   ```json
   {"mode": "...", "since_ms": 0, "since_iso": "...", "now_ms": 0,
    "ticket_filter": "FS-1234"|null, "project_filter": "slug"|null,
    "infer": true, "write": false}
   ```
   `infer` defaults to `true` (inference is always rendered as a secondary section); `write` is `true` only if `--write` was passed.
4. **Return** a single line stating the resolved window (e.g. `incremental: since 2026-06-29 14:05 UTC (last run)` or `first run: all history` or `ad-hoc --days 7`). The orchestrator relays this; only the watermark-advance step may later move the state file.

Only `--reset` mutates the state file here. Advancing the watermark is a separate step.

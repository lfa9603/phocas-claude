---
name: session-map-advance-watermark
description: Advance the session-ticket-mapper watermark after a successful incremental run, so the next default run starts exactly where this one ended. Mechanical file write, default mode only — runs on Haiku. Internal final step of the session-ticket-mapper orchestrator; not for direct use.
model: claude-haiku-4-5-20251001
argument-hint: "<RUN_DIR>"
---

# session-map-advance-watermark

Final step of the `session-ticket-mapper` flow. Move the watermark forward so the next default run covers "everything new since this run". Mechanical file write, so it runs on Haiku.

State file: `~/.claude/observability/session-ticket-mapper.state.json` (resolve `~`; on this machine `C:\Users\LorenzoFasano`).

## Inputs
`$ARGUMENTS` is the `RUN_DIR`. Read `$RUN_DIR/window.json` for `mode` and `now_ms`.

## Steps
1. **Only advance in default incremental mode** (`mode == "incremental"`), and only because the orchestrator reached this step — meaning the render succeeded.
2. For any ad-hoc mode (`days`, `all`, `ticket`, `reset`): do **nothing** — leave the state file untouched so a one-off query never disturbs the incremental cadence. Return `watermark unchanged (ad-hoc <mode> run)`.
3. For incremental mode: write `{"last_run_ts": now_ms, "last_run_iso": "<UTC ISO8601 of now_ms>"}` to the state file.
4. **Return** the watermark change in one line: `watermark advanced: <old iso> → <new iso>` (read the prior value before overwriting).

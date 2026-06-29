---
name: ai-observability
description: Generates an observability report on how this user's AI resources (agents, skills, rules) are being used — invocation counts, success rates, return sizes, trigger phrases, daily volume. Reads a persistent ledger at ~/.claude/observability/ built incrementally from Claude Code transcripts. Use when investigating which resources are working, which are underused, which need their descriptions tuned, or whether a newly-added agent has actually fired yet. Triggers on "observability", "ai usage", "agent metrics", "agent usage", "are my agents working", "how often is X used", "resource stats", "show me my ai stats".
---

# AI Observability Report

Run the bundled `ai-resource-stats.ts` script and present the report with a short interpretive header. The script is pure Node built-ins (no dependencies) and writes a persistent ledger at `~/.claude/observability/invocations.jsonl`, so subsequent runs only process new transcript data.

## Workflow

1. **Resolve the script path.** It ships inside this plugin at `scripts/observability/ai-resource-stats.ts`. Prefer the plugin-root env var; fall back to a search under the plugins cache:

   ```bash
   SCRIPT="${CLAUDE_PLUGIN_ROOT:-}/scripts/observability/ai-resource-stats.ts"
   [ -f "$SCRIPT" ] || SCRIPT=$(find "$HOME/.claude/plugins" -path '*phocas*/scripts/observability/ai-resource-stats.ts' 2>/dev/null | head -1)
   echo "$SCRIPT"
   ```

2. **Determine flags.** If the user passed `$ARGUMENTS`, use that. Otherwise default to `--all-projects --days 30` — cross-project view, last month.

3. **Run the script** with `tsx` (fetched on demand via npx; no install needed). Capture stdout (the markdown report) and stderr (ingestion diagnostics):

   ```bash
   npx -y tsx "$SCRIPT" --all-projects --days 30 2>&1
   ```

4. **Present to the user**, in this order:
   - **A 2–3 sentence interpretive header**: total invocations in the window, top resource by count, and anything notably anomalous (an agent at <90% success, a volume spike, a resource that just fired for the first time).
   - **The full markdown report verbatim** below the header — don't paraphrase or summarise twice. The tables are the artifact.
   - **Any diagnostic warnings** from stderr at the bottom — unknown event shapes mean the parser may be missing data.

5. **If the user asked a specific question** (e.g. "is my `code-cleaner` agent getting used?"), answer it directly using the report as evidence.

## Common flag combinations

| Goal | Flags |
|---|---|
| All projects, last 30 days (default) | `--all-projects --days 30` |
| Specific project only | `--project <slug>` (e.g. `C--stash-fs-app`) |
| Current project only (cwd auto-detected) | _(omit `--all-projects`)_ |
| Longer window | `--days 90` |
| Wipe and rebuild the ledger | `--rebuild` |

## How to read the report

- **`By resource` invocation count** is the primary signal. Zero-count resources don't appear.
- **Success rate < 100%** is non-trivial — read the relevant session's transcript to find the failure.
- **Avg return chars vs the prompt's declared cap** — consistent overflow means the prompt needs tightening.
- **Daily volume gaps** — long gaps for a recurring resource may indicate workflow drift.
- **Rule activations** appear only in single-project reports (run without `--all-projects`); they measure eligibility, not guaranteed injection.

## Companion: session→ticket mapping

This plugin's **`session-ticket-mapper`** agent reads the same `invocations.jsonl` (joined on `session`) plus the `session-tickets.jsonl` ledger written by this plugin's hooks, to group sessions per Jira ticket. Use it when the question is "what work happened under ticket X" rather than "how are my resources performing".

## What you do NOT do

- Re-parse transcripts yourself — the script is authoritative.
- Repeat the entire report in your own words after pasting it verbatim. Pick one.
- Pad with disclaimers about the data being "directional" — the user knows.

## Arguments

`$ARGUMENTS` — Optional flag string passed through to the script verbatim (e.g. `--days 7`, `--project C--stash-phocas`, `--rebuild --days 90`).

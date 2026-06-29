#!/usr/bin/env bash
# Phocas Claude status line — a behavioural cost NUDGE, not cost accounting.
# Reads Claude Code's statusLine JSON on stdin and prints:
#   <model>  |  session: $<cost>  |  week: $<approx>
# See docs/cost-visibility.md for why this must not be treated as a source of
# truth for cost. Requires: jq.
set -euo pipefail

input=$(cat)
model=$(printf '%s' "$input" | jq -r '.model.id // "unknown"')
session_id=$(printf '%s' "$input" | jq -r '.session_id // "unknown"')
session_cost=$(printf '%s' "$input" | jq -r '.cost.total_cost_usd // 0')

# Best-effort week-to-date tally for the engineer's own context only — never
# reported on. Each session contributes its latest cumulative cost ONCE
# (upsert keyed by session_id), so sessions are not double-counted. The weekly
# file name resets the tally automatically each ISO week.
dir="$HOME/.claude/phocas/week"
mkdir -p "$dir"
week=$(date +%G-W%V)
f="$dir/$week.tsv"
tmp="$f.tmp.$$"

{ [ -f "$f" ] && grep -v -P "^${session_id}\t" "$f" || true; printf '%s\t%s\n' "$session_id" "$session_cost"; } > "$tmp"
mv "$tmp" "$f"
week_total=$(awk -F'\t' '{s+=$2} END{printf "%.2f", s}' "$f")

printf '%s  |  session: $%.2f  |  week: $%s\n' "$model" "$session_cost" "$week_total"

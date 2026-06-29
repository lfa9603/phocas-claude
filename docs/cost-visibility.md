# Cost visibility

## What the status bar is

The status bar shows three things: the active model, the live session cost drawn from the statusLine `cost.total_cost_usd` field, and an approximate week-to-date total accumulated across sessions on this machine. The weekly tally is kept locally in `~/.claude/phocas/week/` as a TSV file named by ISO week, with each session contributing its latest cumulative cost once (upserted by session ID, so no double-counting). The file name changes each week, which resets the tally automatically.

The purpose is behavioural. An engineer who can see `claude-opus-4  |  session: $4.12  |  week: $31.40` in the corner of their terminal makes different choices than one who cannot see any of it. Awareness changes habits without requiring any restriction on what engineers can do or which models they can use. Nothing is blocked, and experimentation continues freely.

## What it is not

The status bar is not a cost-tracking system, and it must not be treated as one. Several properties make it unsuitable for attribution or reporting.

It is client-side and per-machine. Cost accumulated on a different machine, or by a colleague, does not appear. It is self-reported: the figures come from the Claude Code client, reconstructed from a pricing table, not from the API billing system. It is partial: sessions that crash, are killed, or run offline may not flush their final cost to the weekly file. The week-to-date figure is useful as a personal gut-check — it is not accurate enough to allocate spend or present to leadership.

## Where cost tracking belongs

Authoritative per-user cost tracking belongs at the API boundary, not on the laptop. The right place to meter usage is a gateway — either AWS Bedrock with per-team API keys, or a self-hosted proxy such as LiteLLM or Bifrost sitting in front of the Anthropic API. A gateway attributes cost server-side by API key, captures every request regardless of which client sent it, and produces a reliable record that can be used for allocation and reporting.

A gateway also generalises naturally across tools. Phocas engineers use Claude Code, ChatGPT, Cursor, and other AI tooling. A gateway approach handles all of them at one integration point. A client-side hook, by contrast, needs a separate brittle integration for each tool, and most of those tools do not expose a statusLine hook at all.

An earlier design in this project included a hook-and-ledger approach that would have aggregated spend locally and pushed it to a shared endpoint. That design was deliberately dropped: the complexity was significant, the data would still have been partial and untrustworthy at the boundaries, and it would have duplicated work that a gateway does correctly by construction. The status bar is the right scope for the client — a nudge, not a meter.

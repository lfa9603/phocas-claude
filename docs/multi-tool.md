# Generalising the base across tools: Claude, Cursor, OpenAI/Codex, Copilot

`phocas-base` solves two things for Claude Code — a shared base context with good-practice defaults, and a path to cost governance. Phocas engineers also use Cursor, ChatGPT/Codex and GitHub Copilot. This doc generalises both ideas across those tools. The headline: the context pattern generalises through an emerging standard file, `AGENTS.md`; cost governance generalises through a hybrid of one gateway plus each vendor's native admin controls. Note the tool landscape moves fast — verify specifics before acting (sources at the end, researched June 2026).

## Part 1 — Shared context and good-practice defaults

### The cross-tool primitive: `AGENTS.md`

`AGENTS.md` is an emerging cross-tool standard for giving coding agents repo context. It is read natively by Codex, Cursor, GitHub Copilot, Windsurf, Aider, Zed and others. Claude Code also reads it, but keeps `CLAUDE.md` as its richer native format — supporting nested memory and user/project scoping that `AGENTS.md` does not offer.

The practical implication for Phocas is to maintain one source of truth for the base rules and project it per tool. An `AGENTS.md` at repo root serves as the portable lowest-common-denominator: every agent that opens the repo picks it up. Tool-native enrichment is then layered on top — `CLAUDE.md` for Claude Code, `.cursor/rules/` plus Team Rules for Cursor, and `~/.codex/AGENTS.md` as a global file for Codex. This keeps the shared signal in one place while preserving the richer capabilities of each tool.

One practical constraint: Codex applies a default size cap to `AGENTS.md` of approximately 32 KiB. Keep the base file lean; move verbose context to referenced files or tool-native formats.

One caveat worth flagging: the claim that `AGENTS.md` has been moved under a Linux Foundation body is widely repeated in the community, but it could not be verified against a primary source in the June 2026 research pass. Treat the standard as de-facto rather than formally ratified.

### Default model and enforcement per tool

Claude Code sets the default model via `settings.json` `model` and applies it for every session. Cursor lets Enterprise admins configure model and provider allow-and-block lists — a capability added in May 2026 — and push non-bypassable Team Rules to all members (precedence: Team > Project > User). Codex stores its defaults in `~/.codex/config.toml`. GitHub Copilot lets admins restrict which models are available to the organisation.

The notable weak spot is ChatGPT Enterprise. Published documentation does not confirm the existence of an admin-enforced org-wide system prompt or an admin-settable default model; this remains unverified and should not be relied upon for governance. In practice, ChatGPT-based usage must fall back on project or custom instructions, not enforcement.

The takeaway: Claude Code, Cursor and Codex can each be given a Phocas default model and shared rules centrally. The ChatGPT consumer and enterprise apps cannot, at least not with the same reliability.

| Tool | Shared / team context | Admin-enforced? | Default-model control |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` (rich) + `AGENTS.md` (portable) | Via plugin / managed settings | `settings.json` `model` |
| Cursor | `.cursor/rules/*.mdc` + `AGENTS.md`; **Team Rules** (admin dashboard) | Yes — Team Rules non-bypassable (Team > Project > User) | Admin model allow/block lists (since May 2026) |
| OpenAI Codex (CLI) | `AGENTS.md` (repo tree + `~/.codex/AGENTS.md` global) | Global file = soft default | `~/.codex/config.toml` |
| ChatGPT Enterprise (app) | Project / custom instructions only | No org-enforced system prompt (unverified) | Not admin-settable (unverified) |
| GitHub Copilot | `AGENTS.md` / repo custom instructions | Repo-committed | Admin model restrictions |

## Part 2 — Cost governance across tools

The principle established in `cost-visibility.md` holds across every tool: meter where the money is spent — the API boundary — not the laptop. The status bar remains a behavioural nudge, not accounting.

The key insight when governing multiple tools is that there are two distinct metering surfaces, and a real organisation needs both, because a gateway can only see traffic you can point at it.

**Gateway (LiteLLM, Bifrost, Portkey, or AWS Bedrock)** handles anything that hits a raw provider API with a key you control — Claude Code, Codex CLI, and any in-house API agents. A gateway gives per-user cost broken down by user ID, key, team, model, and provider (LiteLLM's `user_id` tracking being a concrete example); hard budget caps (LiteLLM's `max_budget` enforces a stop rather than an alert); and model routing and fallback between providers. This is the same gateway surface as Craig's Bedrock track — one meter, all providers.

**Native vendor admin plus Cost API** covers the SaaS-seat applications that cannot be redirected to a gateway. ChatGPT Enterprise exposes a Global Admin Console with a unified Cost API, per-user spend breakdowns with leaderboards, and hard per-user and group limits that cover Codex usage made through the app. Cursor offers Usage Analytics and an Admin API with per-user, per-model, per-day granularity, and hard and soft spend limits introduced in May 2026. GitHub Copilot provides an AI Credits dashboard with per-seat CSV export and four budget levels — setting a user budget to $0 disables the seat entirely. It is worth noting that raw OpenAI API project budgets are alert-based (soft limits) rather than a hard cut-off; do not rely on them as a hard cap.

**The hybrid** is the combination: pull gateway data and each vendor's Cost API into one per-user view. That single aggregated view is what gives leadership a cross-tool picture. No individual tool or vendor provides it on its own.

On rollout approach: prefer alerts-first (soft thresholds) before introducing hard caps. This matches the recommended rollout pattern from every vendor covered here, and is consistent with the proposal's principle of not blocking experimentation.

| Tool / usage | Metering surface | Per-user cost | Hard budget cap |
| --- | --- | --- | --- |
| Claude Code (API key) | Gateway (LiteLLM / Bifrost / Bedrock) or Anthropic admin | Yes — by user / key | Yes (gateway `max_budget`) |
| Codex CLI / raw OpenAI API | Gateway, or OpenAI native | Gateway: yes; raw API: per-project only | Gateway: yes; raw API: soft alerts only |
| ChatGPT Enterprise (app) | Native Global Admin Console + Cost API | Yes (per-user, leaderboards) | Yes (per-user / group) |
| Cursor (app) | Native Usage Analytics + Admin API | Yes (per user / model / day) | Hard + soft limits (since May 2026) |
| GitHub Copilot | Native AI Credits dashboard | Yes (per-seat CSV) | Yes (4 levels; $0 disables seat) |

## Part 3 — What Phocas should do

**Now (no infrastructure required):** Commit a lean `AGENTS.md` alongside the existing `CLAUDE.md` so that Cursor, Codex and Copilot inherit the same base rules. Set the Phocas default model in each tool that supports it — `settings.json` for Claude Code, `~/.codex/config.toml` for Codex, and the Cursor admin model controls for Cursor. Turn on each vendor's native cost dashboard with per-user alerts. All of this is cheap and can be done immediately.

**Next (folds into Craig's Bedrock track):** Stand up a gateway for API-based usage and route Claude Code and Codex CLI through it. This gives per-user cost attribution and the ability to enforce hard caps at a single chokepoint.

**Later:** Aggregate gateway data and vendor Cost APIs into one per-user dashboard. Introduce hard caps alerts-first, starting with soft thresholds and only tightening once the usage picture is clear.

## Caveats and unknowns

- The `AGENTS.md` standard-body status (Linux Foundation affiliation) is widely reported but could not be verified against a primary source — treat the standard as de-facto, not formally ratified.
- ChatGPT Enterprise admin-enforced org-wide system prompt and admin-settable default model are not confirmed features in published documentation — do not rely on either without verification.
- Raw OpenAI API project budgets are soft alerts, not hard caps; they will not stop runaway spend automatically.
- AWS Bedrock per-user hard caps were not verified in this research pass — confirm before depending on them for governance.
- A gateway cannot meter SaaS-seat applications (the ChatGPT app, the Cursor app, GitHub Copilot) — those usage flows require their respective native admin APIs for cost data.

## Sources

- [Cursor — Rules documentation](https://cursor.com/docs/rules.md)
- [Cursor — Changelog: model controls, spend management, usage analytics (May 2026)](https://cursor.com/changelog/05-04-26)
- [OpenAI — ChatGPT Enterprise spend controls (June 2026)](https://openai.com/index/chatgpt-enterprise-spend-controls/)
- [OpenAI Codex — AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md)
- [OpenAI Codex — Enterprise governance](https://developers.openai.com/codex/enterprise/governance)
- [OpenAI — Managing work in the API platform with Projects](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)
- [LiteLLM — Spend / cost tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)
- [GitHub Copilot — moving to usage-based billing (June 2026)](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/)

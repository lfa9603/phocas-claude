# Cost governance

## Why this base exists

Mark's expectation is that AI costs are treated like any other development cost: visible, attributed, and managed thoughtfully — without removing tools or blocking experimentation. At the moment they are none of those things. Spend is growing, but the data shows it is not primarily because engineers are doing more useful work with AI; it is because of two fixable patterns.

The first is Fable used as a default for work Sonnet handles just as well at roughly three times lower cost per token. Fable is a powerful model and earns its place on hard reasoning tasks, but it does not belong in the hot path for routine coding, PR reviews, or debugging sessions. When it lands there by default — because no one ever set a default — cost scales with usage rather than with value.

The second is long sessions with no context hygiene. The dominant cost driver for heavy users is not token generation; it is cache-read tokens. A session that has accumulated 40–70 million cache-read tokens pays a substantial tax on every subsequent turn, whether the context is relevant to that turn or not. Engineers are not doing this deliberately — there is simply no visible signal that it is happening.

## How this plugin addresses both

The `phocas-base` plugin sets Sonnet as the default model. The shared `CLAUDE.md` carries explicit routing rules so engineers and skills can route Haiku, Sonnet, and Opus based on what a task actually demands. The four model-routed skills make the most common patterns concrete: fetching a Jira ticket costs a fraction of a cent on Haiku; producing an implementation plan routes data-gathering to Haiku and the reasoning itself to Opus, cutting a $15–30 Opus-for-everything run to $2–5. Fable remains available but requires an explicit, commented opt-in.

Session hygiene is addressed through guidance in the base context (`/compact`, `/clear` between unrelated tasks, one session per ticket) and through the status-bar nudge, which makes session spend visible in real time. Awareness alone changes behaviour — engineers who can see the cost accumulating make different choices than those who cannot.

## Further reading

The full proposal, including the data behind these observations and the longer-term gateway approach, is at: https://helpphocassoftware.atlassian.net/wiki/x/CYANRgE

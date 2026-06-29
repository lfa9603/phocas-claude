# CLAUDE.md hierarchy

## How Claude Code merges context

Claude Code loads `CLAUDE.md` files from three levels: user, repo, and subdirectory. The user-level file (`~/.claude/CLAUDE.md`) and the repo-level file (`./CLAUDE.md`) are both loaded at session start. Subdirectory files (`./src/<area>/CLAUDE.md`) are loaded on demand as Claude reads files in that part of the tree. All three levels are merged additively — a lower level adds to what is above it, it does not replace it. A repo-level file that says nothing about model routing inherits the full routing table from the base.

This means each level should only state what is genuinely different about that context. There is no need to repeat the base rules; doing so just makes the file harder to maintain and adds noise to the context window.

## The three levels

**User level** — `~/.claude/CLAUDE.md`. This is the Phocas base, shipped by this plugin. It carries the model-routing rules, session-hygiene guidance, and the skill inventory. Never edit this file directly; if you need to change the base, change it in this repo. The plugin install merges it into your user-level file.

**Repo level** — `./CLAUDE.md` at the repository root. This is where a team states what is particular to their codebase: key areas to know about, tech-stack specifics, local conventions, and any model-routing overrides that genuinely apply to the whole repo. See `examples/repo-CLAUDE.md.example`.

**Subdirectory level** — `./src/<area>/CLAUDE.md`. Optional. Useful when a specific part of the codebase has its own conventions or requires particular care, and loading that context for the entire session would be wasteful. These files load on demand, which keeps unrelated sessions lean.

## Worked example

Suppose the `fs-app` team finds that Sonnet frequently misses the root cause in E2E test failures — verbose output, tricky async timing, hard to follow. They want Opus for that specific work, but Sonnet is fine everywhere else. Their repo `CLAUDE.md` looks like this:

```markdown
# fs-app
<!-- Everything not stated here — model routing, session hygiene, shared skills — is inherited from the Phocas base. -->

## Repo context
- src/grid/ — core grid, the oldest part of the codebase, handle with care
- src/dashboards/ — newer and more experimental, conventions still evolving
- src/charts/ — chart-builder, owned by the visualisation team

## Model override for this repo
For E2E test debugging in this repo, use Opus rather than Sonnet. The test output
is verbose and Sonnet regularly misses the root cause. Everything else follows
the base routing table.

## Local conventions
- Never edit files under .generated/ — they are produced by the build pipeline
- Run `pnpm test:e2e --headed` before marking any E2E task complete
- New components go under src/components/[feature-name]/
```

The key point: the team states the override for one task type, and inherits everything else. The base routing table for Haiku, Sonnet, and Opus still applies to all other work in that repo. See `examples/repo-CLAUDE.md.example` for the full file.

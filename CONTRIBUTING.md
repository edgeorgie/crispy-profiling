# Contributing

Thanks for helping make React re-renders less mysterious! 🥓

## Setup

```bash
git clone https://github.com/edgeorgie/crispy-profilling.git
cd crispy-profilling
npm ci
npx tsx src/cli.ts install   # Chromium matching our playwright-core
npm run check                # lint + typecheck + tests + build
```

Node 20+ is required (`.nvmrc` pins 22).

## Project layout

| Path | What |
| --- | --- |
| `src/profiler/hook.ts` | Code injected into the page. Must stay self-contained (it is serialized). |
| `src/profiler/run.ts` | Playwright orchestration: scenarios, steps, phases, settling. |
| `src/report/` | Aggregation, budgets, comparison, Markdown rendering. |
| `src/mcp/server.ts` | MCP tools. |
| `src/cli.ts` | CLI. |
| `skills/` | Agent Skill(s) shipped to agents. |
| `test/fixtures/app` | React app with a naive and an optimized variant used by the e2e tests. |

## Rules of thumb

- **Determinism first.** Reports must be byte-for-byte reproducible for the same app and scenario.
  No timestamps, locale-dependent sorting or wall-clock data unless `timings: true`.
- **Every metric needs an e2e test** against the fixture app with exact expected numbers.
- Keep runtime dependencies minimal (currently: MCP SDK, playwright-core, zod).
- Run `npm run check` before pushing; CI runs the same plus manifest validation.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

## Releasing (maintainers)

```bash
npm version minor          # syncs .claude-plugin/plugin.json and server.json, commits, tags
git push --follow-tags     # the Release workflow publishes npm, MCP Registry and GitHub release
```

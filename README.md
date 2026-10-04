# 🥓 crispy-profiling

**Snapshot testing for React re-renders — deterministic, runtime-proven, with the fix.**

[![CI](https://github.com/edgeorgie/crispy-profilling/actions/workflows/ci.yml/badge.svg)](https://github.com/edgeorgie/crispy-profilling/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/crispy-profiling.svg)](https://www.npmjs.com/package/crispy-profiling)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/edgeorgie/crispy-profilling/badge)](https://scorecard.dev/viewer/?uri=github.com/edgeorgie/crispy-profilling)

> **Status: proof of concept.** It works end to end on the test app; we are now validating it on
> real-world React apps. Feedback and case studies are the most valuable contribution right now.

crispy-profiling opens your React app in headless Chromium, runs the interactions you describe, and
tells you **which components rendered, how many times, why** (props / state / context / parent) and
**which renders were avoidable**. Render counts are deterministic, so two reports of the same scenario
only differ when the code changed. That makes it a reliable feedback loop for:

- **AI coding agents**: an MCP server and an [Agent Skill](skills/react-render-profiling/SKILL.md)
  so Claude Code, Cursor, Codex, Copilot & co. can *measure* a re-render fix instead of guessing.
- **CI**: render budgets and baseline comparison that fail a PR when a component starts re-rendering.
- **You**: a CLI that answers "why does this re-render?" without opening DevTools.

No code changes in your app: it uses the same hook React DevTools uses. Tested on React 19; React
16.8–18 expose the same hook and should work, but are not covered by tests yet.

## Quick start

```bash
npm i -D crispy-profiling
npx crispy install                                   # downloads the matching Chromium (once)
npx crispy init --base-url http://localhost:5173     # creates crispy.config.json
npm run dev &                                        # your app, development build
npx crispy run                                       # writes .crispy/report.json + prints a summary
```

```text
### Scenario `list` (`/`, 3 runs)

**Phase `interaction`** — 1 commits, 24 renders, 23 avoidable (3 wasted)

| Component   | Renders | Avoidable | Causes (props/state/context/unstable/parent) | Unstable props |
| ----------- | ------: | --------: | -------------------------------------------- | -------------- |
| Row         |      20 |        20 | 0/0/0/20/0                                   | `onSelect`×20  |
| Header      |       1 |         1 | 0/0/0/0/1                                    | —              |
| Status      |       1 |         1 | 0/0/0/0/1                                    | —              |
| ThemedLabel |       1 |         1 | 0/0/0/0/1                                    | —              |
| App         |       1 |         0 | 0/1/0/0/0                                    | —              |
```

Every `Row` re-rendered because `onSelect` got a new identity → `useCallback` in the parent plus
`React.memo(Row)` fixes it: `onSelect` is an *unstable* prop (same code, new identity), so all 20
renders are avoidable. `Header` re-rendered with identical props → wasted.

## Render snapshots (`crispy test`)

Like Jest snapshots, but for re-renders. Commit the expected render counts of your key flows; every
PR — written by a person or an AI agent — is checked against them at runtime.

```bash
npx crispy test        # 1st run: writes crispy.snap.json → commit it
npx crispy test        # later: fails if any component renders more (or more avoidably)
npx crispy test -u     # accept intended changes / lock in improvements
npx crispy test --ci   # in CI: a missing snapshot fails instead of being written (default when CI=true)
```

When something regresses you get the component, the cause, where it is rendered and the fix:

```text
| 🔴 regressed | list / interaction | Row | renders | — → 20 | `onSelect` recreated on every render with the
  same content (rendered at src/App.tsx:42): stabilize with useCallback/useMemo or hoist it, and wrap the
  child in React.memo (or enable React Compiler). |
```

`crispy.snap.json` has one line per component, so the PR diff shows exactly which counts changed:

```json
"interaction": {
  "commits": 1,
  "components": {
    "App": { "renders": 1, "avoidable": 0 },
    "Header": { "renders": 1, "avoidable": 1 }
  }
}
```

Rules: any increase in commits, renders or avoidable renders fails (`snapshot.tolerance` allows
slack), and every metric is checked independently, so an improvement never hides a regression.
Counts that varied between runs are stored as `[min, max]` ranges and only fail outside them.
Decreases pass and suggest `-u`; new components that only mount are recorded automatically; the
snapshot always covers every component (even with `topComponents`); budgets still apply.

## Configuration

`crispy.config.json` ([JSON Schema](schema/crispy.config.schema.json)):

```json
{
  "$schema": "./node_modules/crispy-profiling/schema/crispy.config.schema.json",
  "baseUrl": "http://localhost:5173",
  "runs": 3,
  "scenarios": [
    {
      "name": "search",
      "path": "/products",
      "steps": [
        { "action": "type", "selector": "#search", "value": "shoes" },
        { "action": "phase", "name": "sort" },
        { "action": "click", "selector": "text=Price: low to high" }
      ],
      "budgets": {
        "interaction": { "maxAvoidableRenders": 0, "components": { "ProductCard": { "maxRenders": 20 } } }
      }
    }
  ]
}
```

| Field | Default | Description |
| --- | --- | --- |
| `baseUrl` | — | Origin of the running app. |
| `runs` | `3` | Runs per scenario; the report keeps median/min/max and flags unstable counts. |
| `settleMs` | `300` | A step is "settled" after this long without React commits **and** without in-flight network requests. |
| `maxSettleMs` | `10000` | Max wait per step. Pages that never settle (polling, animations) produce a warning in the report instead of hanging. |
| `clock` | `false` | Control timers with a fake clock (`setTimeout`, `setInterval`, `requestAnimationFrame`, `Date`, `performance`) so polling/animated apps give deterministic counts. |
| `timeoutMs` | `30000` | Max time for navigation, a step or settling. |
| `timings` | `false` | Add component self time + LCP/CLS/long tasks. Off by default: timings are not reproducible. |
| `topComponents` | `0` | Keep only the N most-rendered components per phase (`0` = all). |
| `viewport` | `1280×800` | Browser viewport. |
| `browser` | headless | `executablePath`, `channel` (e.g. `"chrome"`), `headless`. `CRISPY_CHROMIUM_PATH` also works. |
| `snapshot` | `crispy.snap.json`, `0` | `file` (relative to the config file) and `tolerance` used by `crispy test`. |
| `compare` | `10%`, `1` | `rendersIncreasePct` and `minRendersDelta` used by `compare`. |

**Steps:** `click`, `hover`, `fill`, `type`, `press`, `scroll`, `waitFor`, `wait`, `goto`, `phase`.
Renders before the first step are recorded in phase `load`; renders during steps go to
`interaction` unless you name phases yourself with `{ "action": "phase", "name": "..." }`.

**Budgets** (per phase): `maxCommits`, `maxTotalRenders`, `maxAvoidableRenders`, `maxWastedRenders`,
and per component `maxRenders` / `maxAvoidableRenders` / `maxWastedRenders`.
A budget for a phase the scenario never produces is a config error; a component budget that never
matches a rendered component produces a warning (likely a typo). Budgets always see every component,
even when `topComponents` trims the report.

## What the numbers mean

| Field | Meaning |
| --- | --- |
| `renders` | Times the component function/class rendered (mounts + updates). |
| `avoidableRenders` | Updates where nothing really changed: wasted renders plus renders caused only by recreated-but-equal inputs. The number to drive down. |
| `wastedRenders` | Updates where props (shallow), state and consumed context were all unchanged. |
| `causes.props / state / context` | Updates where that input changed (one update can have several causes). |
| `causes.unstable` | Only identities changed: inline callbacks, object/array literals, context values or hook results recreated with equal contents. |
| `causes.parent` | Updates with no changed input: the parent re-rendered (same as wasted). |
| `unstableProps` | Prop keys that changed identity but not content — usually fixed with `useCallback`/`useMemo`, hoisting, or React Compiler. |
| `changedProps` | Prop keys whose identity changed, with counts — the "why" behind `causes.props`. |
| `locations` | Up to 3 places where the component is rendered, as `file:line (Owner)` (owner JSX call site). Lines refer to the code the browser runs. |
| `Item#2` keys | Distinct components that share a display name get numbered keys in first-seen order. |
| `stable` | `false` when counts differ between runs (timers, network, randomness). |

Profile the **development** build: production builds minify component names.

## CLI

```text
crispy init [--base-url <url>]          Create crispy.config.json
crispy install [--with-deps]            Download the Chromium build crispy uses
crispy run [-c file] [-o file] [-s scenario...] [--markdown file] [--no-fail]
crispy test [-c file] [-u|--update] [--ci] [-s scenario...] [--markdown file]
crispy compare <base.json> <head.json> [--threshold 10] [--min-delta 1] [--markdown file] [--json file] [--no-fail]
crispy mcp                              Start the MCP server on stdio
```

Exit codes: `0` ok · `1` budget violation or regression · `2` usage/runtime error.

## For AI agents

### MCP server

Tools: `profile_url`, `run_scenarios`, `test_render_snapshots`, `compare_reports`, `inspect_component`.

```json
{
  "mcpServers": {
    "crispy-profiling": { "command": "npx", "args": ["-y", "crispy-profiling@latest", "mcp"] }
  }
}
```

Claude Code: `claude mcp add crispy-profiling -- npx -y crispy-profiling@latest mcp`

### Claude Code plugin (MCP server + skill)

```text
/plugin marketplace add edgeorgie/crispy-profilling
/plugin install crispy-profiling@crispy-profiling
```

### Agent Skill (Claude Code, Cursor, Codex, Copilot, Gemini CLI, …)

```bash
npx skills add edgeorgie/crispy-profilling
```

The skill teaches the agent the measure → fix → re-measure → compare loop and how to map each signal
to a fix (`React.memo`, `useCallback`, `useMemo`, context splitting, state colocation).

## CI (GitHub Action)

```yaml
- uses: edgeorgie/crispy-profilling@v0
  with:
    config: crispy.config.json
    baseline: .crispy/base.json   # optional: report from the base branch
```

The job summary gets the Markdown report; the step fails on budget violations or regressions. A full
base-vs-PR workflow is in [`examples/github-workflow.yml`](examples/github-workflow.yml).

## Programmatic API

```ts
import { compareReports, parseConfig, profile } from 'crispy-profiling';

const config = parseConfig({ baseUrl: 'http://localhost:5173', scenarios: [{ name: 'home' }] });
const report = await profile(config);
```

## How it works

An init script installs (or wraps) `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React loads. On every
commit it walks the new fiber tree against its alternate, like React DevTools, and records each
component that performed work, comparing props, hook state and context values to classify the cause.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (GitFlow: branch from
`develop`). AI coding agents: start with [AGENTS.md](AGENTS.md); docs index for LLMs:
[llms.txt](llms.txt).

## License

[MIT](LICENSE) © Edwin Jorge

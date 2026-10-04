# 🥓 crispy-profiling

**Snapshot testing for React re-renders — deterministic, runtime-proven, with the fix.**

[![CI](https://github.com/edgeorgie/crispy-profiling/actions/workflows/ci.yml/badge.svg)](https://github.com/edgeorgie/crispy-profiling/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/crispy-profiling.svg)](https://www.npmjs.com/package/crispy-profiling)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/edgeorgie/crispy-profiling/badge)](https://scorecard.dev/viewer/?uri=github.com/edgeorgie/crispy-profiling)

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

> Not on npm yet — until the first release, install from GitHub:
> `npm i -D github:edgeorgie/crispy-profiling#develop` (it builds on install).

```bash
npm i -D crispy-profiling
npx crispy install                                   # downloads the matching Chromium (once)
npx crispy init --base-url http://localhost:5173     # creates crispy.config.json
npm run dev &                                        # your app, development build
npx crispy run                                       # writes .crispy/report.json + prints a summary
```

```text
### Scenario `list` (`/`, 3 runs)

**Phase `interaction`** — 1 commits, 24 renders, 3 avoidable (2 wasted), 20 from recreated callbacks

| Component   | Renders | Avoidable | Callback | Causes (props/state/context/unstable/callback/parent) | Unstable props | Callback props | Rendered at         |
| ----------- | ------: | --------: | -------: | ----------------------------------------------------- | -------------- | -------------- | ------------------- |
| Row         |      20 |         0 |       20 | 0/0/0/0/20/0                                          | —              | `onSelect`×20  | `src/App.tsx:42 (App)` |
| Header      |       1 |         1 |        0 | 0/0/0/0/0/1                                           | —              | —              | `src/App.tsx:30 (App)` |
| Status      |       1 |         1 |        0 | 0/0/0/1/0/0                                           | `style`×1      | —              | `src/App.tsx:36 (App)` |
| ThemedLabel |       1 |         1 |        0 | 0/0/0/0/0/1                                           | —              | —              | `src/App.tsx:31 (App)` |
| App         |       1 |         0 |        0 | 0/1/0/0/0/0                                           | —              | —              | —                   |
```

_"Rendered at" and `definedIn` are mapped back to your original source files and lines through the
source maps your dev server or bundler serves (inline or linked); without source maps they refer to
the code the browser runs._

Every `Row` re-rendered because `onSelect` is a new function with the same code on each `App`
render. If the values it uses did not change, `useCallback` (with those values as dependencies) plus
`React.memo(Row)` removes all 20 renders — crispy reports these as *callback* renders because it
cannot see what a closure captures. `Status` got an inline `style` object with equal data
(certainly avoidable) and `Header` re-rendered with identical props (wasted).

## Render snapshots (`crispy test`)

Like Jest snapshots, but for re-renders. Commit the expected render counts of your key flows; every
PR — written by a person or an AI agent — is checked against them at runtime.

```bash
npx crispy test        # 1st run: writes crispy.snap.json → commit it
npx crispy test        # later: fails if any component renders more (or more avoidably)
npx crispy test -u     # accept intended changes / lock in improvements
npx crispy test --ci   # in CI: a missing snapshot fails instead of being written (auto-detected; --no-ci to opt out)
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
Counts that varied between runs are stored as `[min, max]` ranges and only fail outside them
(`-u` keeps the known range instead of narrowing it). Decreases pass and suggest `-u`. New UI
passes and is reported (record it with `-u`); if it already renders avoidably it is flagged ⚠️
(set `snapshot.failOnNewAvoidable` to fail instead). A known component that starts re-rendering
in a phase still fails. A rename, even combined with a move to another file, with the same counts
is reported as 🔁 renamed, not as a regression.
`crispy test` never edits the committed file on its own; the
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
| `cpuThrottle` | `1` | Slow the CPU down (e.g. `4`) to check counts on a slow CI runner or low-end device. Counts should not change. |
| `clock` | `false` | Control timers with a fake clock (`setTimeout`, `setInterval`, `requestAnimationFrame`, `Date`, `performance`) so polling/animated apps give deterministic counts. |
| `timeoutMs` | `30000` | Max time for navigation, a step or settling. |
| `timings` | `false` | Add component self time + LCP/CLS/long tasks. Off by default: timings are not reproducible. |
| `topComponents` | `0` | Keep only the N most-rendered components per phase (`0` = all). |
| `viewport` | `1280×800` | Browser viewport. |
| `browser` | headless | `executablePath`, `channel` (e.g. `"chrome"`), `headless`. `CRISPY_CHROMIUM_PATH` also works. |
| `includeInternals` | `false` | Show framework/library internals (components defined in `node_modules` that only library code renders, e.g. Next.js router internals). Library components your code renders directly are always shown. |
| `snapshot` | `crispy.snap.json`, `0`, `false` | `file` (relative to the config file), `tolerance` and `failOnNewAvoidable` used by `crispy test`. |
| `compare` | `10%`, `1` | `rendersIncreasePct` and `minRendersDelta` used by `compare`. |

**Steps:** `click`, `hover`, `fill`, `type`, `press`, `scroll`, `waitFor`, `wait`, `goto`, `phase`.
`type` presses one key at a time and waits for React to finish (including deferred values and
transitions) before the next key, so concurrent features give the same counts on fast and slow CPUs.
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
| `avoidableRenders` | Updates where nothing really changed: wasted renders plus renders caused only by recreated-but-equal data (objects, arrays, elements, dates, maps…). Certainly avoidable. |
| `callbackRenders` | Updates caused only by functions recreated with the same code (inline callbacks). Avoidable if the values they capture did not change — crispy cannot see captures, so they are reported apart. |
| `wastedRenders` | Updates where props (shallow), state and consumed context were all unchanged. |
| `causes.props / state / context` | Updates where that input changed (one update can have several causes). |
| `causes.unstable` | Only data identities changed: object/array literals, dates, maps, context values or hook results recreated with equal contents. |
| `causes.callback` | Only functions were recreated with the same code (bound/native functions count as real changes). |
| `causes.parent` | Updates with no changed input: the parent re-rendered (same as wasted). |
| `unstableProps` | Prop keys recreated with equal data — fix with `useMemo` or by hoisting constants. |
| `callbackProps` | Prop keys that were recreated callbacks — fix with `useCallback` and the right dependencies, or React Compiler. |
| `changedProps` | Prop keys whose identity changed, with counts — the "why" behind `causes.props`. |
| `triggeredBy` | Components whose own state update started the cascade that re-rendered this one, with counts. Fix the trigger, not every child. |
| `recreatedContextFrom` | Components that own a context provider whose `value` was recreated with equal content (e.g. `value={{ user, logout }}`) — memoize the value there. |
| `memo` | `true` when the component is wrapped in `React.memo`, so hints never suggest wrapping it again. |
| `creators` | `prop|Component`: who created each recreated prop (components that only forwarded it are skipped) — where the fix goes. |
| `staleMemo` | `prop|Component|#2 (an object)`: the prop already comes from `useCallback`/`useMemo`, but those dependencies change on every render. |
| `providerAt` | Where the provider of a recreated context value is rendered. |
| `compiled` | `true` when React Compiler compiled the component. |
| `locations` | Up to 3 places where the component is rendered, as `file:line (Owner)` (owner JSX call site, most frequent first), resolved through source maps when available. |
| `Item (src/List.tsx)` keys | Components are identified by name **and the file that defines them** (resolved through the DevTools protocol). Distinct components that share a name are keyed as `Name (file)`, so adding an unrelated `Item` never renames existing ones; snapshots store the file and keep matching. When files cannot tell them apart (styled-components, HOC factories, several components in one file), they are keyed by where they render (`Item @ src/Card.tsx:12`); numbered keys (`Item#2`) are the last resort. Keys stay the same across `goto` navigations. |
| `definedIn` | File where the component function is defined. |
| `stable` | `false` when counts differ between runs (timers, network, randomness). |

Every Markdown report (`crispy run`, `crispy test`, MCP tools) adds a **Why / how to fix** column
built from these fields. Hints point at the root cause: the component whose state starts a cascade,
the owner that recreates a prop (with its `file:line`), or the provider that recreates a context value.

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
/plugin marketplace add edgeorgie/crispy-profiling
/plugin install crispy-profiling@crispy-profiling
```

### Agent Skill (Claude Code, Cursor, Codex, Copilot, Gemini CLI, …)

```bash
npx skills add edgeorgie/crispy-profiling
```

The skill teaches the agent the measure → fix → re-measure → compare loop and how to map each signal
to a fix (`React.memo`, `useCallback`, `useMemo`, context splitting, state colocation).

## CI (GitHub Action)

```yaml
- run: npm run dev -- --port 5173 & npx -y wait-on http://localhost:5173
- uses: edgeorgie/crispy-profiling@v0   # runs `crispy test --ci` against crispy.snap.json
  with:
    config: crispy.config.json
```

The step fails when any component renders more than the committed snapshot allows (or a budget is
exceeded), and the job summary lists each regression with its cause, where it is rendered and the
suggested fix. `command: run` (with an optional `baseline` report) is available for budget-only or
baseline-comparison setups. Full workflow: [`examples/github-workflow.yml`](examples/github-workflow.yml).

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

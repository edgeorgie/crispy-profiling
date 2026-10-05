# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Snapshots count renders from recreated callbacks as avoidable, like the report does, so putting an
  inline callback back can no longer show up as 🟢 improved. Existing snapshots may need `-u` once.

### Added
- `mutableReads`: renders with unchanged props, state and context whose output still changed (the
  component reads a mutable object such as a TanStack table instance). They are not counted as
  avoidable and never get React.memo advice, which would show stale data.
- `crispy test` reports "🟡 now avoidable" instead of a regression when a component renders as often
  as before but more of those renders are avoidable (a fix uncovered the next cause); it does not
  fail unless `snapshot.failOnMoreAvoidable` is set.
- With `timings: true`, every phase reports its main-thread CPU in ms (`cost.scriptMs` for
  JavaScript, `cost.taskMs` for all main-thread work), measured through the DevTools protocol. Unlike
  component self time it includes reconciliation, effects and styles, and it works in production builds.
- With timings, every root cause shows its estimated cost ("≈ 85 ms of JavaScript") and the
  top-causes lists of `crispy test` and `crispy scan` rank by it, so the expensive fix comes first.
- `crispy scan` (and the `scan_app` MCP tool): zero-config start. Detects the app and its dev
  server, visits a few routes, profiles their safe interactions (buttons, tabs, text inputs; never
  delete, pay, sign out, submit…), prints the top root causes and saves the scenarios that worked as
  `crispy.config.json` for `crispy test`. Read-only by default: writes are blocked in the browser and
  interactions that tried one are not saved.
- `page.evaluate` survives page reloads (Vite reloading after optimizing dependencies).
- Effect cascades: `effectCascades` names the state a `useEffect` sets right after a render (its
  own, a parent's through a setter prop, or a store), blamed on the component whose effect ran,
  with the extra commits and renders it costs, a hint and a root cause ranked above the
  `React.memo` advice it would otherwise produce. `createRoot` on React 18 and 19.

## [0.1.0] - 2026-10-05

First public release: snapshot testing for React re-renders — deterministic, runtime-proven,
with the fix.

### Added
- `crispy test` and `crispy.snap.json`: snapshot tests for render counts per scenario, phase and
  component. Fails on any increase in renders, avoidable renders or commits; flaky counts are
  stored as ranges; renames (also combined with a move) are recognized; new UI is reported, with a
  warning when it already renders avoidably (`snapshot.failOnNewAvoidable` to fail).
- Root-cause fix hints in every report ("Why / how to fix"): the component whose state starts a
  cascade, the component that creates each recreated prop, `useCallback`/`useMemo` whose
  dependencies change, recreated context provider values with their location, and no `React.memo`
  advice for library components or children-only renders.
- Render causes per component: props, state, context, recreated data (`unstable`), recreated
  callbacks (`callback`) and parent re-renders, with prop keys, `triggeredBy`, `creators`,
  `staleMemo`, `recreatedContextFrom`, `memo` and `compiled` (React Compiler).
- Source-mapped locations (`file:line (Owner)`) and definition files for Vite, webpack (including
  eval modules) and Turbopack (sectioned maps); paths are always project-relative or
  `node_modules/...`.
- Stable component identity: same-named components keyed by file (`Item (src/a.tsx)`) or JSX site
  (`styled.div @ src/Card.tsx:12`), stable across runs and full navigations.
- Framework internals hidden by default (`includeInternals` to show them), including Next.js dev
  overlay roots; commits that only touch internals are not counted.
- Scenario runner on Playwright (Chromium): declarative steps (`click`, `type`, `select`, `drag`,
  `waitFor` with state, `goto`…) and phases, settling on network idle and React work, waiting for
  the first render of apps that boot asynchronously, seeded `Math.random`, fake clock, CPU
  throttling, per-key typing.
- Deterministic JSON reports (median/min/max over runs, stability flag); opt-in timings.
- Render budgets and baseline comparison with regression thresholds.
- CLI: `init`, `install`, `run`, `test`, `compare`, `mcp`.
- MCP server: `profile_url`, `run_scenarios`, `test_render_snapshots` (read-only unless confirmed),
  `compare_reports`, `inspect_component` (fuzzy match).
- Agent Skill `react-render-profiling`, Claude Code plugin + marketplace, MCP Registry manifest.
- Composite GitHub Action that runs `crispy test` and writes the job summary.

### Validated on
- Vite 8 + React 19 (React Router, Zustand, TanStack Query, styled-components, React Compiler).
- Next.js 16 (Turbopack and webpack dev servers), React 18.3 and 19.0.
- Open-source apps: Redux Essentials, Next.js App Router Playground, Excalidraw, shadcn-admin and
  the react-admin demo — fixable re-render problems found and fixed in all five (−12 % to −85 %
  renders in the profiled flows).

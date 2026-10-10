# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- "I tried it on my app" issue form (what crispy found, missed or got wrong on a real app), a
  five-line report example in CONTRIBUTING, and a pre-filled issue link after invalid-config
  errors and after the "Not tried" lines of `crispy scan`.

### Docs
- README: the Quick start follows the pitch and the badges, before the demo gif and the status note.

### Changed
- Root causes for recreated props and for state updates now open with a plain sentence ("`Row`
  re-rendered 20 time(s) with nothing new to show, because `App` hands it a new function on every
  render."); the technical cause and the fix follow unchanged.
- `crispy test` lists the measured time per phase when `timings` is on (render counts stay the gate).

## [0.4.0] - 2026-10-10

### Added
- `crispy scan` says what it tried and what it did not: clickable-looking elements that are not
  buttons or links (a `li` with `onClick`), buttons skipped on purpose for a risky name, and safe
  interactions beyond `--actions`. Same list in the MCP `scan_app` output.
- `crispy test` tip: when a component falls to 0 renders in a scenario that has no `expect` step, it
  says a React.memo may have frozen the screen and shows the `expect` step to add.

### Changed
- `crispy scan` now measures time while it profiles, so every root cause says what it costs
  ("≈ 11 ms of JavaScript") and a first-time user can tell whether it is worth fixing. Saved
  scenarios and snapshots are unaffected (timings are not recorded in them).
- `crispy scan <url>` with no config now starts this project's detected dev command when the URL is
  the project's own dev address (an already running server is reused). Before, it failed with
  "Nothing is listening" even though crispy knew the command.
- MCP `test_render_snapshots`: a result with "⚠️ check the UI" rows ends with `Exit status: warn`
  instead of a bare `pass`, so an agent reading the last line does not take it as clean.

### Docs
- Discoverability: the package description, keywords, README intro and plugin descriptions now name
  `crispy-profiling` and say it is a React re-render profiler, so it is not mistaken for the `crispy`
  style-guide package or other tools called crispy.

## [0.3.0] - 2026-10-08

### Security
- The read-only WebSocket guard no longer exempts a bare `/ws` (or any `?token=` URL): an app's own
  `/ws` endpoint received messages from a "read-only" run. Only the dev servers' hot-reload sockets
  (Vite's `/?token=…`, `/_next/…`, webpack-hmr, sockjs-node) pass through. The README says that the
  connection itself is still opened and only what the page sends is dropped.

### Docs
- README CI section: commit the baseline snapshot first, what `@v0` means and how to pin it, what
  happens on fork PRs, and what to do when the job is red.

### Fixed
- A typo inside a step (`"cuont"` on an `expect`, `"clik"` as the action) is now an error with a
  "did you mean" suggestion. It used to be ignored, so an `expect` that checked nothing let a
  frozen UI pass.

### Changed
- Built and tested against playwright-core 1.64.
- Reusing a dev server that is already running no longer prints a warning when crispy checked it
  serves this very app; the warning stays when it could not verify that.
- A snapshot test whose only changes are "⚠️ check the UI" rows no longer shows the green
  "no render regressions" heading or the "lock the improvements in" nudge: it says to check the UI.
- With no snapshot yet, the tip says to record the baseline first (MCP: `update: true`) before
  fixing, instead of promising a 🟢 that cannot appear; the skill says the same.
- `crispy init` writes a load-only starter scenario instead of clicking the first visible button
  (which could be "log out"); the message points to `crispy scan` for finding interactions.
- Components show the name written in the source instead of the one the bundler produced:
  `const Member = memo(function Member…)` was reported as `Member2` (esbuild renames the inner
  function), which nobody can grep. The name comes from the source map; without one nothing changes.
  Existing snapshots show those components as renamed once.
- When a recreated function is passed to several rows per render of its creator, the fix also says
  that `useCallback` cannot go inside a `.map` (pass one stable handler and the item id instead).
- `crispy test --ci` (the default in CI) now fails on a "⚠️ check the UI" row: fewer renders on a
  component that reads mutable data can hide a stale screen, so a person has to confirm the UI and
  accept it with `crispy test -u`. Local runs still only warn.

## [0.2.0] - 2026-10-05

### Breaking
- `readOnly` is on by default in `run`, `test` and the MCP tools, not only in `crispy scan` (the
  Playwright integration is unchanged: there your own test drives the page): replayed clicks never send POST/PUT/DELETE requests or
  WebSocket messages, and what was blocked is listed in the report's warnings. Set
  `"readOnly": false` for flows that must write (e.g. a disposable test database).

### Fixed
- `compare` no longer lists the components of a scenario or phase that ran on one side only as
  🟢 −100%: it says they were not compared (`notCompared`).
- Hints never suggest useCallback/useMemo inside a render function (a TanStack `cell`, lowercase
  keys), where hooks break the rules of hooks: they suggest moving that markup into a component.
- A useEffect that copies a prop into state with equal content (`setShown(items)`) is now reported
  as an effect cascade instead of a recreated prop.
- The first `crispy test` no longer says "No avoidable re-renders 🎉" when the snapshot it wrote has
  avoidable renders without a single standout cause.

### Changed
- `compare` follows renamed components (`Row` → `Row2` after a React.memo) instead of showing them as
  new and -100%, counts recreated-callback renders as avoidable (as snapshots do), and shows the
  JavaScript ms of both reports when they have `timings`.
- MCP `test_render_snapshots` says `Status: WARN` when a component that reads mutable data renders
  less, and a failed `expect` says to undo the change rather than edit the step.
- Without `crispy install`, crispy also finds a Chromium that another Playwright version downloaded
  (`PLAYWRIGHT_BROWSERS_PATH`, `~/.cache/ms-playwright`…), and a launch error lists where it looked.
- A failed `expect` step exits 1 (the app regressed), like a render regression, instead of 2.
- A regression rendered (directly or not) by another regressed component is folded into that
  component's row: one injected `useLocation()` on shadcn-admin gives 3 causes instead of 4.
- An unknown key in `crispy.config.json` (or in a scenario) is an error with a suggestion
  (`unknown key "readonly" (did you mean "readOnly"?)`) instead of being silently ignored.
- MCP `test_render_snapshots` starts with `Status: PASS` or `Status: FAIL`, and `profile_url` takes
  `timings: true` to report JavaScript ms per phase (the skill says how to use it for before/after).
- Snapshots leave out components defined in `node_modules` (icons, Radix parts…): about half the
  size on shadcn-admin, and fewer noisy rows. Old entries are ignored; `snapshot.includeLibraries`
  keeps them.
- Without `crispy install`, crispy uses a Chrome or Chromium already installed in the usual place
  (macOS, Windows, Linux), and `crispy install` says so instead of failing when the download is
  blocked. The install error suggests `browser.executablePath` (saved in the config) over an env var.
- A root cause under 10 renders is optional only if it is also under 20% of the phase's renders.
- Root causes say where the values are created (`src/App.tsx:36`) and give the fix for their kind
  (useCallback for functions, hoist or useMemo for objects) instead of a generic "useCallback / useMemo".
- MCP `test_render_snapshots` speaks MCP: it points at `update=true` and the tool names instead of
  `crispy test -u`.
- `crispy scan` adds `.crispy/` (reports) to `.gitignore` in a git project.
- A renamed component (React.memo often renames `X` to `XImpl`) that reads a mutable instance is
  shown as "⚠️ check the UI" too.
- More commits than the snapshot are reported (ℹ️) but no longer fail `crispy test`: they vary with
  load timing and failed CI on unchanged code. `snapshot.failOnMoreCommits: true` restores the gate.
- Fewer renders on a component that reads a mutable instance (a TanStack table, a form API) or
  mutable data is shown as "⚠️ check the UI" instead of 🟢 in snapshots and `compare`: a React.memo
  there freezes the UI. Snapshots mark such components `"mutable": true`.
- A page with no scripts (another app's static page, a directory listing) fails in ~2 s with the
  "another app" message, instead of waiting 30 s for React.
- Every 🟢 improvement (snapshot and `compare`) now says that fewer renders is not proof the UI still
  updates; the README and the skill say the same.
- Hints no longer suggest React.memo for a component that gets new `children` JSX on most renders
  (the memo would compare and render anyway). Root causes under 10 renders, or under 2% of the
  phase's renders, are marked "Optional (low impact)" (`minor` in the API).
- When a reused server has no React (usually another app on the same port), the error says so first
  and gives a free port and `webServer.command` to use.
- Markdown reports name the causes ("parent re-rendered 30, own state 2") instead of `0/2/0/0/0/30`,
  and the 🟡 snapshot note says it is not worse.
- `crispy install` prints one line while it downloads and, on failure, a short reason instead of
  Playwright's repeated progress lines and stack trace (`--verbose` shows them).
- `crispy scan` keeps one scenario for list rows that differ only by a number ("Member 1",
  "Member 2"…), and says that `crispy test` runs each scenario 3 times.
- Read-only mode (`crispy scan`, `readOnly`) also drops messages the page sends over a WebSocket
  (chat, realtime mutations) and reports them like blocked requests. Dev-server hot-reload sockets
  (Vite, webpack, Next.js) still work.
- Snapshot reports show one row per cause: regressions of components re-rendered by another
  regressed component (or by the same trigger), and the same fix across scenarios, are merged
  ("❌ 142 render regression(s) from 4 causes" on shadcn-admin, down from 142 rows). New components
  show `0 → N` instead of `— → N`.
- Snapshots count renders from recreated callbacks as avoidable, like the report does, so putting an
  inline callback back can no longer show up as 🟢 improved. Existing snapshots may need `-u` once.

### Added
- `expect` step (`selector` with `text` or `count`): fails the scenario when the UI did not update,
  so a memo that freezes the screen fails `crispy test` instead of showing 🟢.
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

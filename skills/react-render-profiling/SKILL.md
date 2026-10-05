---
name: react-render-profiling
description: Measure and fix unnecessary React re-renders with deterministic numbers. Use when a React app feels slow, when asked to optimize renders, add React.memo/useCallback/useMemo, review a performance PR, or verify that a refactor did not add re-renders. Runs the app in headless Chromium via the crispy-profiling CLI or MCP server and reports renders, avoidable renders and their causes (including unstable inline callbacks/objects) per component.
license: MIT
metadata:
  author: edgeorgie
  homepage: https://github.com/edgeorgie/crispy-profiling
---

# React render profiling with crispy-profiling

Never guess about re-renders. Measure, change one thing, measure again, compare.
Render counts from crispy-profiling are deterministic, so any difference between two
reports of the same scenario is caused by the code change.

## Tools

Prefer the MCP tools when they are available (server `crispy-profiling`):

| Tool | Use it to |
| --- | --- |
| `test_render_snapshots` | **Start here** when the project has a `crispy.config.json`: check counts against the committed `crispy.snap.json` (snapshot tests for re-renders). |
| `profile_url` | Profile one URL (+ optional steps). Pass `outFile` to keep the JSON. |
| `run_scenarios` | Run the scenarios of a `crispy.config.json` (with budgets). |
| `compare_reports` | Diff a baseline report against a new one. |
| `inspect_component` | Full causes + changed prop keys for one component. |

Otherwise use the CLI (`npx crispy-profiling <command>`):

```bash
npx crispy-profiling init --base-url http://localhost:5173   # creates crispy.config.json
npx crispy-profiling test        # writes crispy.snap.json the first time, then guards it
npx crispy-profiling run -o .crispy/base.json                # one-off report with fix hints
npx crispy-profiling compare .crispy/base.json .crispy/head.json
```

Chromium is required once: `npx crispy-profiling install`.

If the project already has Playwright tests, prefer adding `renders(page)` + `toMatchSnapshot()`
from `crispy-profiling/playwright` to the relevant test over writing a new scenario.

## Workflow

1. **Dev server**: if `crispy.config.json` has `webServer`, crispy starts it; otherwise start the
   development build yourself and confirm the URL responds. No config yet? `npx crispy init`
   detects the framework, URL and dev command.
2. **Describe the slow interaction as steps** (`click`, `fill`, `type`, `press`, `hover`,
   `select`, `drag`, `scroll`, `waitFor`, `wait`, `goto`, `phase`). Renders before the first step go to
   phase `load`; renders during steps go to `interaction` unless you name phases with
   `{ "action": "phase", "name": "..." }`.
3. **Capture a baseline** before touching code: `crispy test` (records `crispy.snap.json` if it
   does not exist) or a report with `outFile: ".crispy/base.json"`.
4. **Read the report** — start with **Root causes — fix these first** at the top of each phase;
   components are sorted by fixable renders
   (`avoidableRenders + callbackRenders`), then `renders`; read the **Why / how to fix** column.
5. **Fix one cause at a time** using the table below.
6. **Verify**: run `test_render_snapshots` again (🟢 improved, nothing 🔴), or re-profile to
   `.crispy/head.json` and run `compare_reports`. Keep the change only if the target component
   improved and nothing regressed. Report the before/after numbers. A 🔁 renamed or ⚠️ new row is
   not a failure.

## Reading the numbers

Each component has `renders`, `avoidableRenders`, `callbackRenders`, `wastedRenders`, `causes`
(`props`/`state`/`context`/`unstable`/`callback`/`parent`), `unstableProps` (keys recreated with equal data),
`callbackProps` (recreated functions), `changedProps` (prop keys whose identity changed, with counts),
`triggeredBy` (components whose state update started the cascade), `recreatedContextFrom`
(components whose provider recreates a context value) and `memo` (already wrapped in `React.memo`).
The Markdown report has a **Why / how to fix** column with a ready-made hint per component: start
there, and fix the trigger before touching the children it re-renders.

| Signal | Likely cause | Fix |
| --- | --- | --- |
| cause `unstable`, `unstableProps` lists a key | Object/array/element recreated each render with equal data | `useMemo` in the owner or hoist the constant; `React.memo` the child |
| cause `callback`, `callbackProps` lists a key | Inline function recreated each render (same code) | If the values it uses did not change: `useCallback` **with those values as deps** + `React.memo` the child. If they did change, the render is necessary — never use empty deps to silence it |
| `wastedRenders` > 0, cause `parent` | Parent re-rendered, props identical | Wrap in `React.memo`, or move state down so the parent does not re-render |
| `changedProps` lists a function (`onClick`, `onSelect`...) | Inline callback recreated every render | `useCallback` in the parent (and `React.memo` on the child) |
| `changedProps` lists an object/array (`style`, `options`, `items`) | Literal recreated every render | `useMemo` or hoist the constant outside the component |
| `changedProps` lists `children` | JSX children are new elements each time (normal) | `React.memo` will not help: stop the parent from re-rendering, or pass the children from a component that does not re-render |
| `stateChanges` says `store subscription … via useX` | A store/router hook returns a value that changes more often than the component needs | Select only what it uses (pathname, a primitive, a shallow-equal selector) or move the subscription into the child that uses it |
| `staleMemo` lists a prop | It already uses `useCallback`/`useMemo`, but a dependency changes every render | Make that dependency stable (memoize it, or read it inside the callback) |
| component defined in `node_modules` | Library component (styled-components, `Link`…) | Never wrap it: fix the props where your code passes them (`creators` names the component) |
| `triggeredBy` names one component for many others | Its state update re-renders a large subtree | Move that state closer to where it is used, or make the props passed down stable so `React.memo` can skip them |
| `recreatedContextFrom` names a component | Its provider `value` is a new object/function each render | `useMemo` the value (and `useCallback` functions inside it) in that component |
| cause `context` on many components | A broad context value changes | Split the context, memoize the provider `value`, or select narrower state |
| cause `state` with high `renders` | Frequent state updates (typing, scroll) | Debounce, `useDeferredValue`, keep the state local to the leaf |
| `stable: false` (⚠️) | Counts differ between runs (timers, network, randomness) | Add `waitFor` steps or mock the nondeterminism before trusting deltas |

Rules:
- `React.memo` only helps if every prop is stable; check `changedProps` first. If a memo component has
  `memoSkips: 0` and its props really change, remove the memo instead of adding more.
- Do not memoize everything. Fix the components with the most `avoidableRenders` /
  `callbackRenders` and the triggers of large cascades; leave cheap leaf components alone.
  `selfDurationMs` only exists with `"timings": true` (off by default: not reproducible).
- A component missing from a phase did not render in it (0 renders).
- Production builds minify names; profile the development build.

## Render snapshots (prevent regressions)

If the project has a `crispy.snap.json`, run `test_render_snapshots` (or `npx crispy test`) after any
change to React components. A failure lists the regressed component, the unstable prop, where it is
rendered and a suggested fix — apply it and run again. The MCP tool is read-only: only after the
user confirms the new counts are intended, pass `update: true` with
`confirm: "accept-render-changes"` (CLI: `crispy test -u`). **Never accept a snapshot change on
your own to make the test pass** — that hides the regression the test exists to catch; show the
user the diff and ask. If there is no snapshot yet, `crispy test` creates one: tell the user to
commit it.

## Budgets (prevent regressions)

Add budgets per scenario and phase in `crispy.config.json`; `crispy run` exits 1 when one is exceeded:

```json
{
  "baseUrl": "http://localhost:5173",
  "scenarios": [{
    "name": "search",
    "path": "/products",
    "steps": [{ "action": "type", "selector": "#search", "value": "shoes" }],
    "budgets": {
      "interaction": { "maxAvoidableRenders": 0, "components": { "ProductCard": { "maxRenders": 20 } } }
    }
  }]
}
```

For CI, see `examples/github-workflow.yml` in the repository.

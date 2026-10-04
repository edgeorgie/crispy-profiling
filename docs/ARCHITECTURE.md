# Architecture

```
crispy.config.json ──► config.ts (zod) ──► profiler/run.ts ──► Chromium (playwright-core)
                                               │                    │
                                               │   addInitScript ◄──┘ profiler/hook.ts
                                               ▼
                                     raw runs (per phase)
                                               │
                                   report/aggregate.ts ──► CrispyReport (deterministic JSON)
                                               │                    │
                                     budgets (violations)    report/compare.ts ──► CompareResult
                                                                    │
                                                         report/markdown.ts ──► CLI / MCP / Action
```

## Browser hook (`src/profiler/hook.ts`)

1. Before any page script runs, we install `__REACT_DEVTOOLS_GLOBAL_HOOK__` (or wrap an existing
   one). React renderers call `inject(renderer)` once and `onCommitFiberRoot(id, root)` after every
   commit, in development and production builds.
2. On each commit we compare `root.current` with its `alternate`:
   - no alternate / no previous element → **mount** every component fiber in the tree;
   - otherwise walk children, skipping subtrees where `next.child === prev.child` (bailed out);
   - a component fiber **rendered** when its `PerformedWork` flag (bit 1) is set.
3. For each update we classify the cause:
   - **props**: shallow comparison of `memoizedProps` (records the changed keys);
   - **state**: class `memoizedState`, or each hook's `memoizedState` (effect objects ignored,
     because React recreates them on every render);
   - **context**: `dependencies.firstContext` list, comparing `memoizedValue`;
   - **parent**: none of the above → counted as **wasted**.
4. Component tags counted: Function (0), Class (1), Indeterminate (2), ForwardRef (11),
   SimpleMemo (15). `Memo` (14) is skipped because its child fiber is the real component.
5. `selfBaseDuration` (dev/profiling builds only) gives per-component self time when `timings` is on.

The function is serialized with `Function#toString`, so it must be self-contained.
`crispyHookSource()` adds a no-op `__name` helper for transpilers that use `keepNames`.

## Determinism

- Render counts depend only on the code and the scenario, not on CPU speed.
- `settle` waits until no commit happened for `settleMs`, so async renders are included.
- Reports contain no timestamps, absolute URLs or locale-dependent ordering; components are sorted by
  renders desc, then name (`cmp`, code-point order).
- Multi-run medians plus `stable` flag the rare non-deterministic app (timers, random data).

## Comparison rules

Per scenario/phase/component on median renders:

- `regressed`: `delta ≥ minRendersDelta` and (`deltaPct > rendersIncreasePct` or base was 0);
- `added`: new component that only mounts (new UI is fine);
- `improved`: fewer renders (including not rendering at all);
- `unchanged`: otherwise.

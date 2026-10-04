# Agent instructions

- Install: `npm ci && npx tsx src/cli.ts install`. Verify with `npm run check`.
- `src/profiler/hook.ts#installCrispyHook` is serialized into the browser: no imports, no outer
  references, no helpers outside the function.
- Reports must stay deterministic: sort with `cmp` from `src/util/cmp.ts`, never `localeCompare`;
  never add timestamps; wall-clock data only behind `timings`.
- New metrics or steps need exact-number assertions in `test/e2e.test.ts` against
  `test/fixtures/app/App.tsx` (add behavior to the fixture if needed).
- Keep `package.json`, `.claude-plugin/plugin.json` and `server.json` versions in sync
  (`npm version` does it; `test/manifests.test.ts` checks it).
- Update `skills/react-render-profiling/SKILL.md` and the README when user-facing behavior changes.

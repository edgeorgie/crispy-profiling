import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { profile } from '../src/profiler/run.js';
import { serializeReport } from '../src/report/aggregate.js';
import { compareReports } from '../src/report/compare.js';
import type { CrispyReport } from '../src/types.js';
import { buildFixture, serve } from './helpers.js';

let servers: { url: string; close: () => Promise<void> }[] = [];
let slowUrl = '';
let fastUrl = '';

const configFor = (baseUrl: string) =>
  parseConfig({
    baseUrl,
    runs: 2,
    settleMs: 150,
    scenarios: [
      {
        name: 'list',
        path: '/',
        steps: [
          { action: 'click', selector: '#inc' },
          { action: 'phase', name: 'theme' },
          { action: 'click', selector: '#theme-toggle' },
          { action: 'phase', name: 'async' },
          { action: 'click', selector: '#load' },
        ],
        budgets: { interaction: { components: { Row: { maxRenders: 5 } } } },
      },
    ],
  });

beforeAll(async () => {
  const dirs = await buildFixture();
  const slow = await serve(dirs.slow);
  const fast = await serve(dirs.fast);
  servers = [slow, fast];
  slowUrl = slow.url;
  fastUrl = fast.url;
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

describe('profiling a real React app in Chromium', () => {
  let slow: CrispyReport;
  let fast: CrispyReport;

  beforeAll(async () => {
    slow = await profile(configFor(slowUrl));
    fast = await profile(configFor(fastUrl));
  });

  it('detects React and records the mount phase', () => {
    expect(slow.reactVersion).toMatch(/^19\./);
    expect(slow.profilingBuild).toBe(true);
    const load = slow.scenarios.list?.phases.load;
    expect(load?.components.App?.mounts.median).toBe(1);
    expect(load?.components.Row?.mounts.median).toBe(20);
    expect(load?.totalWastedRenders.median).toBe(0);
  });

  it('attributes re-renders to their causes in the naive app', () => {
    const p = slow.scenarios.list?.phases.interaction;
    expect(p?.components.App?.causes.state).toBe(1);
    // Header gets identical props on every App render -> wasted.
    expect(p?.components.Header?.wastedRenders.median).toBe(1);
    expect(p?.components.Header?.causes.parent).toBe(1);
    // Every Row re-renders because onSelect is recreated.
    expect(p?.components.Row?.renders.median).toBe(20);
    expect(p?.components.Row?.changedProps).toEqual({ onSelect: 20 });
  });

  it('separates recreated data (avoidable) from recreated callbacks (C-05, R2-03)', () => {
    const p = slow.scenarios.list?.phases.interaction;
    // Inline `onSelect` is a new function with the same code on every App render:
    // avoidable only if what it captures did not change, so it is reported apart.
    expect(p?.components.Row?.callbackRenders.median).toBe(20);
    expect(p?.components.Row?.avoidableRenders.median).toBe(0);
    expect(p?.components.Row?.callbackProps).toEqual({ onSelect: 20 });
    expect(p?.components.Row?.causes).toEqual({
      props: 0,
      state: 0,
      context: 0,
      unstable: 0,
      callback: 20,
      parent: 0,
    });
    // Inline `style={{...}}` with equal data is certainly avoidable.
    expect(p?.components.Status?.unstableProps).toEqual({ style: 1 });
    expect(p?.components.Status?.causes.unstable).toBe(1);
    // Header + ThemedLabel (parent) + Status (unstable data).
    expect(p?.totalAvoidableRenders.median).toBe(3);
    expect(fast.scenarios.list?.phases.interaction?.totalCallbackRenders.median).toBe(0);
  });

  it('detects context-driven renders', () => {
    const p = slow.scenarios.list?.phases.theme;
    expect(p?.components.ThemedLabel?.causes.context).toBe(1);
    expect(p?.components.ThemedLabel?.wastedRenders.median).toBe(0);
  });

  it('waits for async renders after a step', () => {
    const p = slow.scenarios.list?.phases.async;
    expect(p?.commits.median).toBe(1);
    expect(p?.components.Status?.changedProps).toEqual({ style: 1, text: 1 });
  });

  it('shows the optimized app skipping Row renders', () => {
    const p = fast.scenarios.list?.phases.interaction;
    expect(p?.components.Row).toBeUndefined();
    expect(p?.components.App?.renders.median).toBe(1);
  });

  it('enforces budgets', () => {
    expect(slow.violations).toEqual([
      {
        scenario: 'list',
        phase: 'interaction',
        metric: 'renders',
        component: 'Row',
        limit: 5,
        actual: 20,
      },
    ]);
    expect(fast.violations).toEqual([]);
  });

  it('produces byte-for-byte reproducible reports', async () => {
    const again = await profile(configFor(slowUrl));
    expect(serializeReport(again)).toBe(serializeReport(slow));
  });

  it('flags regressions and improvements when comparing', () => {
    const improved = compareReports(slow, fast);
    expect(improved.passed).toBe(true);
    expect(improved.improvements.some((d) => d.component === 'Row')).toBe(true);

    const regressed = compareReports(fast, slow);
    expect(regressed.passed).toBe(false);
    expect(regressed.regressions.map((d) => `${d.phase}/${d.component}`)).toContain(
      'interaction/Row',
    );
  });
});

describe('settling on real-world async behavior', () => {
  it('waits for slow network responses before closing a step (C-02)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'fetch', steps: [{ action: 'click', selector: '#fetch' }] }],
    });
    const report = await profile(config);
    const p = report.scenarios.fetch?.phases.interaction;
    expect(p?.components.App?.causes.state).toBe(1);
    expect(report.scenarios.fetch?.warnings).toEqual([]);
  });

  it('warns instead of hanging when the page never settles (C-03)', async () => {
    const started = Date.now();
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      maxSettleMs: 800,
      scenarios: [
        { name: 'ticker', path: '/?ticker', steps: [{ action: 'click', selector: '#inc' }] },
      ],
    });
    const report = await profile(config);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.scenarios.ticker?.warnings[0]).toMatch(/did not settle.*Ticker.*"clock": true/);
  });

  it('makes timer-driven apps deterministic with a fake clock (C-03)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 3,
      settleMs: 150,
      maxSettleMs: 600,
      clock: true,
      scenarios: [
        { name: 'ticker', path: '/?ticker', steps: [{ action: 'click', selector: '#inc' }] },
      ],
    });
    const report = await profile(config);
    const ticker = report.scenarios.ticker?.phases.interaction?.components.Ticker;
    expect(ticker?.stable).toBe(true);
    expect(ticker?.renders.median).toBeGreaterThan(0);
  });
});

describe('navigation', () => {
  it('keeps earlier phases across full page navigations (C-04)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'nav',
          steps: [
            { action: 'click', selector: '#inc' },
            { action: 'phase', name: 'after-nav' },
            { action: 'goto', path: '/' },
            { action: 'click', selector: '#inc' },
          ],
          budgets: { interaction: { components: { App: { maxRenders: 0 } } } },
        },
      ],
    });
    const report = await profile(config);
    const phases = report.scenarios.nav?.phases;
    expect(Object.keys(phases ?? {})).toEqual(['load', 'after-nav', 'interaction']);
    expect(phases?.interaction?.components.App?.renders.median).toBe(1);
    // App mounts again after the navigation, then updates on the click.
    expect(phases?.['after-nav']?.components.App?.mounts.median).toBe(1);
    expect(phases?.['after-nav']?.components.App?.updates.median).toBe(1);
    expect(report.violations.map((v) => v.phase)).toEqual(['interaction']);
  });
});

describe('component identity', () => {
  it('keeps distinct components that share a name apart and locates them (C-07)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'dupes', path: '/?dupes' }],
    });
    const load = (await profile(config)).scenarios.dupes?.phases.load;
    expect(load?.components.Item?.renders.median).toBe(1);
    expect(load?.components['Item#2']?.renders.median).toBe(1);
    // Source maps resolve the exact JSX line in the original file; the owner comes
    // from _debugOwner, so Rows created in a .map callback still name App.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('test/fixtures/app/App.tsx', 'utf8').split('\n');
    const lineOf = (needle: string) => src.findIndex((l) => l.includes(needle)) + 1;
    expect(load?.components.Row?.locations).toEqual([
      `test/fixtures/app/App.tsx:${lineOf('<Row key=')} (App)`,
    ]);
    expect(load?.components.Header?.locations).toEqual([
      `test/fixtures/app/App.tsx:${lineOf('<Header title=')} (App)`,
    ]);
    expect(load?.components.Header?.definedIn).toBe('test/fixtures/app/App.tsx');
  });
});

describe('resilience', () => {
  it('turns hook failures into a warning instead of failing the run (C-19)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'boom', path: '/?boom', steps: [{ action: 'click', selector: '#inc' }] }],
    });
    const report = await profile(config);
    expect(report.scenarios.boom?.warnings.join(' ')).toMatch(
      /could not analyze \d+ component render/,
    );
    expect(report.scenarios.boom?.phases.interaction?.components.App?.renders.median).toBe(1);
  });
});

describe('render snapshots (crispy test)', () => {
  it('writes, passes, then catches a regression with a fix hint', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runSnapshotTest } = await import('../src/snapshot-test.js');
    const dir = mkdtempSync(join(tmpdir(), 'crispy-snap-'));
    const config = (baseUrl: string) =>
      parseConfig({
        baseUrl,
        runs: 1,
        settleMs: 150,
        scenarios: [{ name: 'list', steps: [{ action: 'click', selector: '#inc' }] }],
      });

    const first = await runSnapshotTest(config(fastUrl), { baseDir: dir });
    expect(first.written).toBe(true);
    expect(readFileSync(join(dir, 'crispy.snap.json'), 'utf8')).toContain(
      '"Row": { "renders": 20, "avoidable": 0, "file": "test/fixtures/app/App.tsx" }',
    );
    expect((await runSnapshotTest(config(fastUrl), { baseDir: dir })).exitCode).toBe(0);

    const regressed = await runSnapshotTest(config(slowUrl), { baseDir: dir, ci: true });
    expect(regressed.exitCode).toBe(1);
    expect(regressed.result?.regressions).toEqual([
      expect.objectContaining({
        phase: 'interaction',
        component: 'Row',
        actual: 20,
        hint: expect.stringMatching(/`onSelect` is a new function.*useCallback.*necessary/),
      }),
    ]);

    await runSnapshotTest(config(slowUrl), { baseDir: dir, update: true });
    expect((await runSnapshotTest(config(slowUrl), { baseDir: dir, ci: true })).exitCode).toBe(0);
  });
});

describe('concurrent rendering', () => {
  it('gives the same counts on a fast and a 6x slower CPU (R2-02)', async () => {
    const run = async (cpuThrottle: number) => {
      const config = parseConfig({
        baseUrl: slowUrl,
        runs: 2,
        settleMs: 150,
        cpuThrottle,
        scenarios: [
          {
            name: 'deferred',
            path: '/?deferred',
            steps: [
              { action: 'type', selector: '#deferred-input', value: 'abcdefgh', delayMs: 40 },
            ],
          },
        ],
      });
      const p = (await profile(config)).scenarios.deferred?.phases.interaction;
      return { cells: p?.components.SlowCell?.renders, stable: p?.components.SlowCell?.stable };
    };
    const fast = await run(1);
    const slow = await run(6);
    expect(fast.stable).toBe(true);
    // 8 keystrokes × 200 cells, each keystroke fully rendered before the next.
    expect(fast.cells?.median).toBe(1600);
    expect(slow.cells).toEqual(fast.cells);
  });
});

describe('iframes', () => {
  it('keeps phases across navigation when the page has a same-origin iframe (R2-07)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'frame',
          path: '/?iframe',
          steps: [
            { action: 'click', selector: '#inc' },
            { action: 'phase', name: 'after-nav' },
            { action: 'goto', path: '/?iframe' },
            { action: 'click', selector: '#inc' },
          ],
        },
      ],
    });
    const phases = (await profile(config)).scenarios.frame?.phases;
    expect(Object.keys(phases ?? {})).toEqual(['load', 'after-nav', 'interaction']);
    expect(phases?.interaction?.components.App?.renders.median).toBe(1);
  });
});

describe('change classification', () => {
  it('classifies dates, large arrays, bound functions and memo hooks correctly (R2-04/15/16)', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        { name: 'c', path: '/?classify', steps: [{ action: 'click', selector: '#inc' }] },
      ],
    });
    const c = (await profile(config)).scenarios.c?.phases.interaction?.components;
    // Equal Date and 60-item array recreated each render: identity-only, avoidable.
    expect(c?.DateProbe?.causes.unstable).toBe(1);
    expect(c?.ListProbe?.causes.unstable).toBe(1);
    // Bound functions all stringify the same way: a real change, never "callback".
    expect(c?.BoundProbe?.causes).toMatchObject({ props: 1, callback: 0 });
    // useMemo recomputation is derived from props, not a state change.
    expect(c?.Derived?.causes).toMatchObject({ props: 1, state: 0 });
  });
});

describe('stable component identity across modules (R2-05)', () => {
  it('does not flag existing components when an unrelated same-named one is added', async () => {
    const { buildModuleFixture, serveModules } = await import('./helpers.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runSnapshotTest } = await import('../src/snapshot-test.js');
    const app = await serveModules(await buildModuleFixture());
    const dir = mkdtempSync(join(tmpdir(), 'crispy-identity-'));
    const config = (path: string) =>
      parseConfig({
        baseUrl: app.url,
        runs: 1,
        settleMs: 150,
        scenarios: [{ name: 'list', path, steps: [{ action: 'click', selector: '#inc' }] }],
      });
    try {
      const base = await runSnapshotTest(config('/'), { baseDir: dir });
      const item = base.report.scenarios.list?.phases.interaction?.components.Item;
      expect(item?.definedIn).toBe('src/ListItem.tsx');

      const withBanner = await runSnapshotTest(config('/?banner'), { baseDir: dir, ci: true });
      const keys = Object.keys(
        withBanner.report.scenarios.list?.phases.interaction?.components ?? {},
      );
      expect(keys).toEqual(
        expect.arrayContaining(['Item (src/ListItem.tsx)', 'Item (src/BannerItem.tsx)']),
      );
      // Only the genuinely new component is reported; the list items still match.
      expect(withBanner.result?.regressions.map((r) => r.component)).toEqual([
        'Item (src/BannerItem.tsx)',
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('framework internals (R2-24)', () => {
  it('hides components only library code renders, keeps library components the app renders', async () => {
    const { buildModuleFixture, serveModules } = await import('./helpers.js');
    const app = await serveModules(await buildModuleFixture());
    const run = (includeInternals: boolean) =>
      profile(
        parseConfig({
          baseUrl: app.url,
          runs: 1,
          settleMs: 150,
          includeInternals,
          scenarios: [
            { name: 'lib', path: '/?lib', steps: [{ action: 'click', selector: '#lib' }] },
          ],
        }),
      );
    try {
      const hidden = await run(false);
      const comps = hidden.scenarios.lib?.phases.interaction?.components ?? {};
      expect(Object.keys(comps)).toContain('LibButton');
      expect(Object.keys(comps)).not.toContain('LibInner');
      expect(hidden.scenarios.lib?.hiddenInternals).toBe(1);

      const shown = await run(true);
      expect(Object.keys(shown.scenarios.lib?.phases.interaction?.components ?? {})).toContain(
        'LibInner',
      );
    } finally {
      await app.close();
    }
  });
});

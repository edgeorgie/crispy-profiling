import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { profile } from '../src/profiler/run.js';
import { serializeReport } from '../src/report/aggregate.js';
import { compareReports } from '../src/report/compare.js';
import { hintFor } from '../src/report/hints.js';
import type { CrispyReport } from '../src/types.js';
import { buildFixture, serve, writes } from './helpers.js';

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
    expect(Object.keys(phases ?? {})).toEqual(['load', 'interaction', 'after-nav']); // declaration order (R4-11)
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
    // Source maps resolve the exact JSX line in the original file; the owner comes
    // from _debugOwner, so Rows created in a .map callback still name App.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('test/fixtures/app/App.tsx', 'utf8').split('\n');
    const lineOf = (needle: string) => src.findIndex((l) => l.includes(needle)) + 1;
    // Both are defined in the same file, so they are keyed by where they render (R3-07).
    const site = (needle: string) => `Item @ test/fixtures/app/App.tsx:${lineOf(needle)}`;
    expect(load?.components[site('<ItemA />')]?.renders.median).toBe(1);
    expect(load?.components[site('<ItemB />')]?.renders.median).toBe(1);
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

    // The memoized variant drops Row to 0 renders: without an expect step crispy cannot tell a
    // win from a frozen screen, so it says so and shows the step to add (council round 5).
    const fixed = await runSnapshotTest(config(fastUrl), { baseDir: dir });
    expect(fixed.markdown).toMatch(/`Row` fell to 0 renders[\s\S]*"action": "expect"/);
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
    expect(Object.keys(phases ?? {})).toEqual(['load', 'interaction', 'after-nav']); // declaration order (R4-11)
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
      // Only the genuinely new component is reported, as an addition (R4-05); the list
      // items still match.
      expect(withBanner.result?.regressions).toEqual([]);
      expect([...new Set(withBanner.result?.additions.map((r) => r.component))]).toEqual([
        'Item (src/BannerItem.tsx)',
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('component identity across navigations (R3-08)', () => {
  it('keeps same-named components apart when a later document renders them in another order', async () => {
    const { buildModuleFixture, serveModules } = await import('./helpers.js');
    const app = await serveModules(await buildModuleFixture());
    try {
      const config = parseConfig({
        baseUrl: app.url,
        runs: 1,
        settleMs: 150,
        scenarios: [
          {
            name: 'nav',
            path: '/',
            steps: [
              { action: 'click', selector: '#inc' },
              { action: 'phase', name: 'banner' },
              // The new document renders BannerItem's `Item` before the list items.
              { action: 'goto', path: '/?banner' },
              { action: 'click', selector: '#inc' },
            ],
          },
        ],
      });
      const phases = (await profile(config)).scenarios.nav?.phases;
      const renders = (phase: string) =>
        Object.fromEntries(
          Object.entries(phases?.[phase]?.components ?? {})
            .filter(([k]) => k.startsWith('Item'))
            .map(([k, c]) => [k, c.renders.median]),
        );
      expect(renders('interaction')).toEqual({ 'Item (src/ListItem.tsx)': 2 });
      expect(renders('banner')).toEqual({
        'Item (src/BannerItem.tsx)': 2,
        'Item (src/ListItem.tsx)': 4,
      });
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
      // The count depends on dev-server state, so it is only reported with timings.
      expect(hidden.scenarios.lib?.hiddenInternals).toBeUndefined();

      const shown = await run(true);
      expect(Object.keys(shown.scenarios.lib?.phases.interaction?.components ?? {})).toContain(
        'LibInner',
      );
    } finally {
      await app.close();
    }
  });
});

describe('webpack eval source maps (R3-02)', () => {
  it('maps webpack-internal eval modules to original lines', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'evaled', path: '/eval' }],
    });
    const header = (await profile(config)).scenarios.evaled?.phases.load?.components.Header;
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('test/fixtures/app/App.tsx', 'utf8').split('\n');
    const line = src.findIndex((l) => l.includes('<Header title=')) + 1;
    expect(header?.locations).toEqual([`test/fixtures/app/App.tsx:${line} (App)`]);
    expect(header?.definedIn).toBe('test/fixtures/app/App.tsx');
  });
});

describe('root-cause hints (R3-04, R3-05)', () => {
  it('points context consumers at the provider and memo components at the recreated prop', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        { name: 'c', path: '/?ctxvalue', steps: [{ action: 'click', selector: '#inc' }] },
        { name: 'ctx', path: '/?ctxvalue', steps: [{ action: 'click', selector: '#cart-bump' }] },
      ],
    });
    const report = await profile(config);
    const phase = report.scenarios.c?.phases.interaction;
    const c = phase?.components;
    // The provider re-renders alone: its recreated value is the only reason.
    const ctx = report.scenarios.ctx?.phases.interaction;
    expect(ctx?.components.CartBadge?.recreatedContextFrom).toEqual({ CartProvider: 1 });
    expect(hintFor(ctx?.components.CartBadge, ctx, 'CartBadge')).toContain('`CartProvider`');
    // When the parent re-creates the element anyway, context is not blamed (R5-02).
    expect(c?.CartBadge?.recreatedContextFrom).toEqual({});
    // ...but React.memo alone would not help it: it says so (council round 1).
    expect(c?.CartBadge?.maskedContextFrom).toEqual({ CartProvider: 1 });
    expect(hintFor(c?.CartBadge, phase, 'CartBadge')).toContain(
      'React.memo alone will not skip it',
    );
    expect(c?.Swatch?.memo).toBe(true);
    expect(hintFor(c?.Swatch, phase, 'Swatch')).toContain('already wrapped in React.memo');
    // App's count update started the cascade.
    expect(c?.CartShell?.triggeredBy).toEqual({ App: 1 });
  });
});

describe('first-run errors (R4-19)', () => {
  it('says the dev server is not running instead of a raw network error', async () => {
    const config = parseConfig({
      baseUrl: 'http://127.0.0.1:47123',
      runs: 1,
      scenarios: [{ name: 'x' }],
    });
    await expect(profile(config)).rejects.toThrow(/Is the dev server running\?/);
  });
});

describe('empty phases (R5-01)', () => {
  it('records a phase with no renders, so renders there later fail the snapshot', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'quiet',
          steps: [
            { action: 'phase', name: 'idle' },
            { action: 'wait', ms: 50 },
          ],
        },
      ],
    });
    const idle = (await profile(config)).scenarios.quiet?.phases.idle;
    expect(idle?.commits.median).toBe(0);
    expect(idle?.components).toEqual({});
  });
});

describe('async boot (R5-10)', () => {
  it('waits for the first render of apps that boot asynchronously', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        { name: 'late', path: '/?lateboot', steps: [{ action: 'click', selector: '#inc' }] },
      ],
    });
    const phases = (await profile(config)).scenarios.late?.phases;
    expect(phases?.load?.components.App?.mounts.median).toBe(1);
    expect(phases?.interaction?.components.App?.updates.median).toBe(1);
  });
});

describe('select and drag steps (R5-07)', () => {
  it('profiles choosing an option and dragging with the pointer', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 's',
          path: '/?steps',
          steps: [
            { action: 'phase', name: 'pick' },
            { action: 'select', selector: '#pick', value: 'b' },
            { action: 'phase', name: 'drag' },
            { action: 'drag', selector: '#slider', dx: 60, steps: 5 },
            { action: 'waitFor', selector: '#nothing-here', state: 'detached' },
          ],
        },
      ],
    });
    const phases = (await profile(config)).scenarios.s?.phases;
    expect(phases?.pick?.components.Picker?.updates.median).toBe(1);
    // pointer down + 5 moves + up, each a state update.
    expect(phases?.drag?.components.Slider?.updates.median).toBeGreaterThanOrEqual(5);
  });
});

describe('apps behind a login', () => {
  it('signs in once with scripted steps and environment credentials', async () => {
    process.env.CRISPY_TEST_USER = 'demo-user';
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 2,
      settleMs: 150,
      login: {
        path: '/?auth',
        steps: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: crispy reads ${NAME} from the environment
          { action: 'fill', selector: '#user', value: '${CRISPY_TEST_USER}' },
          { action: 'click', selector: '#login' },
          { action: 'waitFor', selector: '#inc' },
        ],
      },
      scenarios: [{ name: 'in', path: '/?auth', steps: [{ action: 'click', selector: '#inc' }] }],
    });
    const phases = (await profile(config)).scenarios.in?.phases;
    // Every run starts signed in: the app, not the login form, renders.
    expect(phases?.load?.components.App?.mounts.median).toBe(1);
    expect(phases?.load?.components.Login).toBeUndefined();
  });
});

describe('named state causes', () => {
  it('names the state hook or store subscription behind a render', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'n',
          path: '/?store',
          steps: [
            { action: 'phase', name: 'own' },
            { action: 'click', selector: '#inc' },
            { action: 'phase', name: 'store' },
            { action: 'click', selector: '#store-bump' },
          ],
        },
      ],
    });
    const phases = (await profile(config)).scenarios.n?.phases;
    expect(phases?.own?.components.App?.stateChanges).toEqual({ '`count` (useState)': 1 });
    expect(phases?.store?.components.StoreReader?.stateChanges).toEqual({
      'store subscription (useSyncExternalStore) in `useCounterStore`': 1,
    });
  });
});

describe('useless React.memo', () => {
  it('flags a memo only when it skipped nothing in the whole scenario (R6-08)', async () => {
    const inc = { action: 'click' as const, selector: '#inc' };
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        { name: 'only-inc', path: '/?memo', steps: [inc, inc, inc] },
        {
          name: 'inc-then-theme',
          path: '/?memo',
          steps: [
            inc,
            inc,
            inc,
            // App re-renders with the same count: the memo skips CounterView here.
            { action: 'phase', name: 'theme' },
            { action: 'click', selector: '#theme-toggle' },
          ],
        },
      ],
    });
    // Only the flow where the memo never helps: flagged.
    const alone = await profile({ ...config, scenarios: config.scenarios.slice(0, 1) });
    const useless = alone.scenarios['only-inc']?.phases.interaction;
    expect(useless?.components.CounterView?.uselessMemo).toBe(true);
    expect(hintFor(useless?.components.CounterView, useless, 'CounterView')).toContain(
      'React.memo did not skip any render in these flows',
    );
    // With a flow where it skips renders anywhere in the report: never flagged (R7-04).
    const report = await profile(config);
    for (const s of Object.values(report.scenarios)) {
      const c = s.phases.interaction?.components.CounterView;
      expect(c?.memoSkips).toBeGreaterThan(0);
      expect(c?.uselessMemo).toBeUndefined();
    }
    // The memo that always works skipped its renders, so it is not in the interaction at all.
    expect(useless?.components.LabelView).toBeUndefined();
  });
});

describe('Playwright Test integration', () => {
  it('records renders in an existing test and fails with the fix', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { renders } = await import('../src/playwright.js');
    const { launchBrowser } = await import('../src/profiler/run.js');
    const browser = await launchBrowser(
      parseConfig({ baseUrl: slowUrl, scenarios: [{ name: 'x' }] }),
    );
    const snapshotDir = mkdtempSync(join(tmpdir(), 'crispy-pw-'));
    const flow = async (url: string) => {
      const page = await browser.newPage();
      try {
        const r = await renders(page, { snapshotDir, ci: false, config: { settleMs: 150 } });
        await page.goto(url);
        await r.phase('select');
        await page.click('#inc');
        await r.toMatchSnapshot('list');
      } finally {
        await page.close();
      }
    };
    try {
      await flow(fastUrl); // writes __renders__/list.snap.json
      await flow(fastUrl); // matches
      await expect(flow(slowUrl)).rejects.toThrow(/Row[\s\S]*`onSelect` is a new function/);
    } finally {
      await browser.close();
    }
  });
});

describe('named state causes: ground truth (R6-01, R6-02)', () => {
  it('names the right hook after multi-slot hooks and custom hooks', async () => {
    const steps = ['a', 'b', 'c', 'd', 'e'].flatMap((x) => [
      { action: 'phase' as const, name: x },
      { action: 'click' as const, selector: `#lab-${x}` },
    ]);
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'lab', path: '/?lab', steps }],
    });
    const p = (await profile(config)).scenarios.lab?.phases;
    const names = (phase: string, c: string) =>
      Object.keys(p?.[phase]?.components[c]?.stateChanges ?? {});
    expect(names('a', 'StoreThenState')).toEqual(['`count` (useState)']);
    expect(names('b', 'StateThenStore')).toEqual(['`v` (useSyncExternalStore)']);
    expect(names('b', 'StoreHookOnly')).toEqual([
      'store subscription (useSyncExternalStore) in `useMiniStore`',
    ]);
    expect(names('c', 'TransitionThenState')).toEqual(['`tab` (useState)']);
    expect(names('d', 'StoreHookThenReducer')).toEqual(['`n` (useReducer)']);
    expect(names('e', 'CustomThenState')).toEqual(['`label` (useState)']);
  });
});

describe('effect cascades', () => {
  it('counts state set by a useEffect right after a render, nothing else', async () => {
    const ids = ['effect', 'async', 'layout', 'none', 'transition', 'deferred', 'timer', 'mount'];
    const steps = ids.flatMap((x) => [
      { action: 'phase' as const, name: x },
      { action: 'click' as const, selector: `#cascade-${x}` },
      { action: 'click' as const, selector: `#cascade-${x}` },
    ]);
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'cascade', path: '/?cascade', steps }],
    });
    const p = (await profile(config)).scenarios.cascade?.phases;
    const cascades = (phase: string) =>
      Object.fromEntries(
        Object.entries(p?.[phase]?.components ?? {})
          .filter(([, c]) => c.effectCascades)
          .map(([name, c]) => [name, c.effectCascades]),
      );
    expect(cascades('load')).toEqual({});
    const doubled = { '`doubled` (useState)': 2 };
    expect(cascades('effect')).toEqual({ EffectDerived: doubled });
    expect(cascades('async')).toEqual({ TimerThenEffect: doubled });
    const c = p?.effect?.components.EffectDerived;
    expect(hintFor(c, p?.effect, 'EffectDerived')).toMatch(
      /a useEffect here sets `doubled` \(useState\) right after rendering, 2 time/,
    );
    for (const id of ids.slice(2)) expect(cascades(id), id).toEqual({});
  });
});

describe('effect cascades: attribution (red-team round 8)', () => {
  it('blames the component whose effect ran, also across lists and stores', async () => {
    const ids = ['prop', 'rows', 'store', 'copy'];
    const steps = ids.flatMap((x) => [
      { action: 'phase' as const, name: x },
      { action: 'click' as const, selector: `#cascade-${x}` },
      { action: 'click' as const, selector: `#cascade-${x}` },
    ]);
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'r8', path: '/?round8', steps }],
    });
    const p = (await profile(config)).scenarios.r8?.phases;
    const cascades = (phase: string) =>
      Object.fromEntries(
        Object.entries(p?.[phase]?.components ?? {})
          .filter(([, c]) => c.effectCascades)
          .map(([name, c]) => [name, [c.effectCascades, c.cascadeCommits]]),
      );
    expect(cascades('load')).toEqual({});
    // R8-02: the child that calls the setter, not the parent that owns the state.
    expect(cascades('prop')).toEqual({
      Doubler: [{ '`total` (useState) in `ParentOfDoubler` (via a prop)': 2 }, 2],
    });
    // R8-01: a new row mounting does not hide the existing rows' cascades.
    expect(cascades('rows')).toEqual({ ListRow: [{ '`label` (useState)': 5 }, 2] }); // 2 + 3 rows
    // R8-03: the component that writes the store in its effect.
    expect(cascades('store')).toEqual({
      EffectStoreWriter: [{ 'a store read by `EffectStoreReader`': 2 }, 2],
    });
    // Council round 3: the copy has equal content, it is still the effect's commit.
    // esbuild renames the memo's inner function (Copier2).
    expect(Object.values(cascades('copy'))).toEqual([[{ '`shown` (useState)': 2 }, 2]]);
    const hint = hintFor(p?.prop?.components.Doubler, p?.prop, 'Doubler');
    expect(hint).toMatch(/call the parent's setter in the event handler/);
  });
});

describe('crispy scan', () => {
  it('finds safe interactions on its own and the effect cascade among them', async () => {
    const { scan } = await import('../src/scan.js');
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'x' }],
    });
    const result = await scan(config, { path: '/?cascade', maxRoutes: 1, maxActions: 6, runs: 1 });
    // scan measures time, so each cause says what it costs in ms (council round 5, newcomer).
    expect(result.causes.some((c) => /≈ \d+ ms of JavaScript/.test(c.text))).toBe(true);
    expect(result.skipped.map((s) => s.reason)).toEqual([]);
    const names = result.scenarios.map((s) => s.name);
    expect(names.length).toBe(6);
    // Every scenario re-runs from scratch; the effect cascade is found without writing steps.
    const derived = Object.values(result.report.scenarios).find(
      (s) => s.phases.interaction?.components.EffectDerived?.effectCascades,
    );
    expect(derived).toBeDefined();
    expect(result.causes.some((c) => c.text.includes('A useEffect in `EffectDerived`'))).toBe(true);
  }, 180_000);
});

describe('crispy scan safety (red-team round 9)', () => {
  it('never sends a write and never saves an interaction that tried', async () => {
    const { scan } = await import('../src/scan.js');
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'x' }],
    });
    writes.length = 0;
    const result = await scan(config, { path: '/?trap', maxRoutes: 2, maxActions: 30, runs: 1 });
    expect(writes).toEqual([]);
    const selectors = result.scenarios.flatMap((s) => s.steps.map((st) => JSON.stringify(st)));
    for (const bad of ['Eliminar', 'Supprimer', '🗑', 'Bulk actions', 'Go', 'Sign-out', 'bye'])
      expect(selectors.join('\n'), bad).not.toContain(bad);
    // Clicked, blocked, reported, not saved.
    expect(result.skipped.find((s) => s.name.includes('save-changes'))?.reason).toMatch(
      /tried to send POST .*\/api\/save \(blocked, not saved\)/,
    );
    expect(result.scenarios.some((s) => s.name.includes('add-item'))).toBe(true);
    // What scan did not exercise is said out loud (council round 5).
    // A clickable row with a short text is clicked by that text (council round 5).
    expect(result.scenarios.some((s) => s.name.includes('row-a'))).toBe(true);
    // Icon-only buttons are clicked once per icon; a table of pointer rows gets its
    // second row clicked through an anchored selector (council round 6).
    const steps = result.scenarios.flatMap((s) => s.steps);
    expect(
      steps.some((st) => 'selector' in st && st.selector === 'role=button[name="☆"] >> nth=0'),
    ).toBe(true);
    expect(
      steps.some((st) => 'selector' in st && st.selector === '#orders tbody > tr >> nth=1'),
    ).toBe(true);
    const notTried = result.notTried.join('\n');
    expect(notTried).toMatch(
      /1 clickable-looking element\(s\) without a short text to click them by \(div ×1\)/,
    );
    expect(notTried).toMatch(/skipped on purpose because the name looks risky: .*"Eliminar"/);
    // List rows that differ only by a number are one scenario, not three.
    expect(result.scenarios.filter((s) => s.name.includes('member')).length).toBe(1);
  }, 180_000);
});

describe('CPU per phase (timings)', () => {
  it('reports main-thread ms per phase only with timings', async () => {
    const steps = [{ action: 'click' as const, selector: '#inc' }];
    const base = { baseUrl: slowUrl, runs: 1, settleMs: 150, scenarios: [{ name: 'c', steps }] };
    const timed = (await profile(parseConfig({ ...base, timings: true }))).scenarios.c?.phases;
    expect(timed?.load?.cost?.scriptMs.median).toBeGreaterThan(0);
    expect(timed?.interaction?.cost?.taskMs.median).toBeGreaterThan(0);
    // Root causes carry an estimated cost and say it.
    const { rootCauses } = await import('../src/report/hints.js');
    const causes = timed?.interaction ? rootCauses(timed.interaction) : [];
    expect(causes.length).toBeGreaterThan(0);
    for (const c of causes) expect(c.ms).toBeGreaterThanOrEqual(0);
    expect(causes.some((c) => /≈ \d+ ms of JavaScript/.test(c.text))).toBe(true);
    const plain = (await profile(parseConfig(base))).scenarios.c?.phases;
    expect(plain?.interaction?.cost).toBeUndefined();
    // crispy test shows the measured time per phase when timings are on (council round 5).
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runSnapshotTest } = await import('../src/snapshot-test.js');
    const dir = mkdtempSync(join(tmpdir(), 'crispy-timings-'));
    const written = await runSnapshotTest(parseConfig({ ...base, timings: true }), {
      baseDir: dir,
    });
    expect(written.markdown).toMatch(/Time per phase[\s\S]*- c \/ interaction: \d+ ms JavaScript/);
  });
});

describe('memoized dependencies by name (council round 1)', () => {
  it('names the dependency that changes', async () => {
    const steps = [
      { action: 'click' as const, selector: '#deps-add' },
      { action: 'click' as const, selector: '#deps-add' },
    ];
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'deps', path: '/?deps', steps }],
    });
    const p = (await profile(config)).scenarios.deps?.phases.interaction;
    // esbuild renames the memo's inner function (AddButton2).
    const button = Object.entries(p?.components ?? {}).find(([k]) =>
      k.startsWith('AddButton'),
    )?.[1];
    expect(Object.keys(button?.staleMemo ?? {})).toEqual(['onAdd|Deps|`cart` (an array)']);
  });
});

describe('readOnly configs (council round 1)', () => {
  it('blocks writes when scanned interactions are replayed', async () => {
    writes.length = 0;
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      readOnly: true,
      scenarios: [
        {
          name: 'trap',
          path: '/?trap',
          steps: [{ action: 'click', selector: 'text=Save changes' }],
        },
      ],
    });
    await profile(config);
    expect(writes).toEqual([]);
  });

  it('is read-only by default and lists what it blocked (decision D2)', async () => {
    writes.length = 0;
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'save',
          path: '/?trap',
          steps: [{ action: 'click', selector: 'text=Save changes' }],
        },
      ],
    });
    const report = await profile(config);
    expect(writes).toEqual([]);
    expect(
      report.scenarios.save?.warnings.some((w) => /read-only: blocked POST .*\/api\/save/.test(w)),
    ).toBe(true);
    // Opting out lets the write through.
    await profile(parseConfig({ ...config, readOnly: false }));
    expect(writes).toEqual(['POST /api/save']);
  });

  it('drops what the page sends over a WebSocket', async () => {
    const blocked: string[] = [];
    writes.length = 0;
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 300,
      readOnly: true,
      scenarios: [
        {
          name: 'live',
          path: '/?trap',
          steps: [{ action: 'click', selector: 'text=Send message' }],
        },
      ],
    });
    await profile(config, { onBlockedRequest: (_s, what) => blocked.push(what) });
    expect(blocked.some((b) => b.startsWith('WebSocket send ws://') && b.endsWith('/live'))).toBe(
      true,
    );
    expect(writes).toEqual([]);
  });
});

describe('mutable reads (council round 1, expert)', () => {
  it('never calls renders that show changing mutable data avoidable', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'm',
          path: '/?mutable',
          steps: [
            { action: 'click', selector: '#mutable-next' },
            { action: 'click', selector: '#mutable-next' },
          ],
        },
      ],
    });
    const p = (await profile(config)).scenarios.m?.phases.interaction;
    const pagination = p?.components.Pagination;
    expect(pagination?.mutableReads).toBe(2);
    expect(pagination?.wastedRenders.median).toBe(0);
    expect(hintFor(pagination, p, 'Pagination')).toMatch(/do not wrap it in React.memo/i);
    // Same instance, unchanged output in this flow: memo would still be unsafe (round 2).
    const toolbar = p?.components.Toolbar;
    expect(toolbar?.instanceProps).toEqual({ table: 2 });
    expect(toolbar?.wastedRenders.median).toBe(0);
    expect(hintFor(toolbar, p, 'Toolbar')).toContain('Do not wrap it in React.memo');
    // A sibling with truly unchanged output is still a wasted render.
    expect(p?.components.Static?.wastedRenders.median).toBe(2);
  });
});

describe('source names (council round 4)', () => {
  it('reports the name written in the source, not the one the bundler gave', async () => {
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'b', path: '/?bundled', steps: [] }],
    });
    const names = Object.keys((await profile(config)).scenarios.b?.phases.load?.components ?? {});
    expect(names).toContain('Member');
    expect(names).not.toContain('Member2');
  });
});

describe('expect step (council round 3)', () => {
  it('passes when the UI updates and fails the scenario when it does not', async () => {
    const steps = [
      { action: 'click' as const, selector: '#inc' },
      { action: 'expect' as const, selector: '#inc', text: 'count 1' },
    ];
    const ok = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [{ name: 'e', steps }],
    });
    expect((await profile(ok)).scenarios.e).toBeDefined();
    const frozen = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      timeoutMs: 2000,
      scenarios: [{ name: 'f', steps: [steps[0], { ...steps[1], text: 'count 2' }] }],
    });
    await expect(profile(frozen)).rejects.toThrow(
      /expect failed: "#inc" should show text "count 2", found text "count 1"/,
    );
  });

  it('keeps the results of the other scenarios when a step fails (council round 5, P11)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runSnapshotTest } = await import('../src/snapshot-test.js');
    const config = parseConfig({
      baseUrl: slowUrl,
      runs: 1,
      settleMs: 150,
      timeoutMs: 2000,
      scenarios: [
        { name: 'good', steps: [{ action: 'click', selector: '#inc' }] },
        { name: 'bad', steps: [{ action: 'click', selector: '#does-not-exist' }] },
      ],
    });
    const baseDir = mkdtempSync(join(tmpdir(), 'crispy-partial-'));
    const first = await runSnapshotTest(config, { baseDir });
    // The good scenario is recorded; the bad one is named, and exit 2 says crispy could not run it.
    expect(first.exitCode).toBe(2);
    expect(Object.keys(first.report.scenarios)).toEqual(['good']);
    expect(first.markdown).toContain('1 scenario(s) did not run to the end: **bad**');
    // On the next run the good scenario still compares against its snapshot.
    const second = await runSnapshotTest(config, { baseDir });
    expect(second.exitCode).toBe(2);
    expect(second.result?.passed).toBe(true);
  });
});

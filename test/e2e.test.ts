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

  it('counts identity-only prop changes as avoidable renders (C-05)', () => {
    const p = slow.scenarios.list?.phases.interaction;
    // Inline `onSelect` is recreated with the same source on every App render.
    expect(p?.components.Row?.avoidableRenders.median).toBe(20);
    expect(p?.components.Row?.unstableProps).toEqual({ onSelect: 20 });
    expect(p?.components.Row?.causes).toEqual({
      props: 0,
      state: 0,
      context: 0,
      unstable: 20,
      parent: 0,
    });
    // 20 Rows + Header + ThemedLabel + Status; the optimized variant keeps the last three.
    expect(p?.totalAvoidableRenders.median).toBe(23);
    expect(fast.scenarios.list?.phases.interaction?.totalAvoidableRenders.median).toBe(3);
  });

  it('detects context-driven renders', () => {
    const p = slow.scenarios.list?.phases.theme;
    expect(p?.components.ThemedLabel?.causes.context).toBe(1);
    expect(p?.components.ThemedLabel?.wastedRenders.median).toBe(0);
  });

  it('waits for async renders after a step', () => {
    const p = slow.scenarios.list?.phases.async;
    expect(p?.commits.median).toBe(1);
    expect(p?.components.Status?.changedProps).toEqual({ text: 1 });
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
    // Rows are created inside an anonymous map callback; Header directly in App.
    expect(load?.components.Row?.locations).toEqual([expect.stringMatching(/^bundle\.js:\d+$/)]);
    expect(load?.components.Header?.locations).toEqual([
      expect.stringMatching(/^bundle\.js:\d+ \(App\)$/),
    ]);
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
      '"Row": { "renders": 20, "avoidable": 0 }',
    );
    expect((await runSnapshotTest(config(fastUrl), { baseDir: dir })).exitCode).toBe(0);

    const regressed = await runSnapshotTest(config(slowUrl), { baseDir: dir, ci: true });
    expect(regressed.exitCode).toBe(1);
    expect(regressed.result?.regressions).toEqual([
      expect.objectContaining({
        phase: 'interaction',
        component: 'Row',
        actual: 20,
        hint: expect.stringMatching(/`onSelect` recreated.*useCallback/),
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

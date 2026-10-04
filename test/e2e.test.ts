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

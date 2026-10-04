import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildReport, checkBudgets, stat } from '../src/report/aggregate.js';
import { compareReports } from '../src/report/compare.js';
import { compareToMarkdown, reportToMarkdown } from '../src/report/markdown.js';
import type { ComponentReport, CrispyReport, PhaseReport, RawRun } from '../src/types.js';

const s = (n: number) => ({ median: n, min: n, max: n });

function component(renders: number, updates = renders, wasted = 0): ComponentReport {
  return {
    renders: s(renders),
    mounts: s(renders - updates),
    updates: s(updates),
    wastedRenders: s(wasted),
    avoidableRenders: s(wasted),
    causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: wasted },
    changedProps: {},
    unstableProps: {},
    callbackProps: {},
    callbackRenders: s(0),
    locations: [],
    stable: true,
  };
}

function phase(components: Record<string, ComponentReport>): PhaseReport {
  const total = Object.values(components).reduce((a, c) => a + c.renders.median, 0);
  const wasted = Object.values(components).reduce((a, c) => a + c.wastedRenders.median, 0);
  return {
    commits: s(1),
    totalRenders: s(total),
    totalWastedRenders: s(wasted),
    totalAvoidableRenders: s(wasted),
    totalCallbackRenders: s(0),
    components,
  };
}

function report(phases: Record<string, PhaseReport>): CrispyReport {
  return {
    schemaVersion: 1,
    tool: { name: 'crispy-profiling', version: '0.0.0' },
    reactVersion: '19.0.0',
    profilingBuild: true,
    scenarios: { home: { name: 'home', path: '/', runs: 1, phases, violations: [], warnings: [] } },
    violations: [],
  };
}

describe('config', () => {
  it('applies defaults', () => {
    const c = parseConfig({ baseUrl: 'http://localhost:3000', scenarios: [{ name: 'home' }] });
    expect(c.runs).toBe(3);
    expect(c.timings).toBe(false);
    expect(c.scenarios[0]?.path).toBe('/');
    expect(c.compare).toEqual({ rendersIncreasePct: 10, minRendersDelta: 1 });
  });

  it('rejects invalid configs with a readable error', () => {
    expect(() => parseConfig({ baseUrl: 'nope', scenarios: [] })).toThrow(/Invalid crispy config/);
    expect(() =>
      parseConfig({ baseUrl: 'http://x.dev', scenarios: [{ name: 'a' }, { name: 'a' }] }),
    ).toThrow(/duplicate scenario "a"/);
    expect(() =>
      parseConfig({
        baseUrl: 'http://x.dev',
        scenarios: [{ name: 'a', steps: [{ action: 'explode' }] }],
      }),
    ).toThrow(/Invalid crispy config/);
  });
});

describe('stat', () => {
  it('computes median/min/max', () => {
    expect(stat([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3 });
    expect(stat([1, 2, 3, 4])).toEqual({ median: 2.5, min: 1, max: 4 });
    expect(stat([])).toEqual({ median: 0, min: 0, max: 0 });
  });
});

describe('budgets', () => {
  it('reports every exceeded limit in a stable order', () => {
    const phases = { load: phase({ Row: component(30, 10, 8), App: component(1, 0) }) };
    const v = checkBudgets('home', phases, {
      load: {
        maxTotalRenders: 10,
        maxWastedRenders: 100,
        components: { Row: { maxRenders: 20, maxWastedRenders: 5 }, App: { maxRenders: 1 } },
      },
      missing: { maxCommits: 0 },
    });
    expect(v).toEqual([
      { scenario: 'home', phase: 'load', metric: 'totalRenders', limit: 10, actual: 31 },
      {
        scenario: 'home',
        phase: 'load',
        metric: 'renders',
        component: 'Row',
        limit: 20,
        actual: 30,
      },
      {
        scenario: 'home',
        phase: 'load',
        metric: 'wastedRenders',
        component: 'Row',
        limit: 5,
        actual: 8,
      },
    ]);
  });
});

describe('compareReports', () => {
  const base = report({
    interaction: phase({ Row: component(10), List: component(2), Old: component(4) }),
  });

  it('flags increases above the threshold', () => {
    const head = report({
      interaction: phase({ Row: component(12), List: component(2), Old: component(4) }),
    });
    const r = compareReports(base, head);
    expect(r.passed).toBe(false);
    expect(r.regressions.map((d) => [d.component, d.delta, d.deltaPct])).toEqual([['Row', 2, 20]]);
  });

  it('respects threshold and minimum delta', () => {
    const head = report({
      interaction: phase({ Row: component(11), List: component(3), Old: component(4) }),
    });
    expect(compareReports(base, head).regressions.map((d) => d.component)).toEqual(['List']);
    expect(compareReports(base, head, { rendersIncreasePct: 60 }).passed).toBe(true);
    expect(compareReports(base, head, { minRendersDelta: 2 }).passed).toBe(true);
  });

  it('treats vanished components as improvements and new mount-only ones as added', () => {
    const head = report({
      interaction: phase({ Row: component(10), List: component(2), Modal: component(1, 0) }),
    });
    const r = compareReports(base, head);
    expect(r.passed).toBe(true);
    expect(r.improvements.map((d) => d.component)).toEqual(['Old']);
    expect(r.diffs.find((d) => d.component === 'Modal')?.status).toBe('added');
  });

  it('treats new components that re-render as regressions', () => {
    const head = report({
      interaction: phase({
        Row: component(10),
        List: component(2),
        Old: component(4),
        Spinner: component(5),
      }),
    });
    expect(compareReports(base, head).regressions.map((d) => d.component)).toEqual(['Spinner']);
  });
});

describe('markdown', () => {
  it('renders reports and comparisons', () => {
    const r = report({ load: phase({ 'A|B': component(3, 2, 1) }) });
    const md = reportToMarkdown(r);
    expect(md).toContain('A\\|B');
    expect(md).toContain('No budget violations');
    const cmd = compareToMarkdown(compareReports(r, r));
    expect(cmd).toContain('no render regressions');
  });
});

describe('budget validation (C-17)', () => {
  it('rejects budgets for phases the scenario never produces', () => {
    expect(() =>
      parseConfig({
        baseUrl: 'http://x.dev',
        scenarios: [
          { name: 'a', steps: [{ action: 'click', selector: 'b' }], budgets: { interactoin: {} } },
        ],
      }),
    ).toThrow(/unknown phase "interactoin". Known phases: load, interaction/);
  });

  it('checks budgets before topComponents trims the list and flags unknown components', () => {
    const raw = (renders: number) => ({
      renders,
      mounts: 0,
      updates: renders,
      wastedRenders: 0,
      avoidableRenders: 0,
      changedProps: {},
      unstableProps: {},
      callbackProps: {},
      callbackRenders: 0,
      locations: {},
      causes: { props: 0, state: renders, context: 0, unstable: 0, callback: 0, parent: 0 },
      selfDurationMs: 0,
    });
    const run: RawRun = {
      reactVersion: '19',
      profilingBuild: true,
      phases: { load: { commits: 1, components: { Big: raw(9), Small: raw(2) } } },
      vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
      warnings: [],
    };
    const config = parseConfig({
      baseUrl: 'http://x.dev',
      topComponents: 1,
      scenarios: [
        {
          name: 'a',
          budgets: { load: { components: { Small: { maxRenders: 1 }, Smal: { maxRenders: 1 } } } },
        },
      ],
    });
    const report = buildReport([{ scenario: config.scenarios[0] as never, runs: [run] }], config);
    expect(report.violations.map((v) => v.component)).toEqual(['Small']);
    expect(Object.keys(report.scenarios.a?.phases.load?.components ?? {})).toEqual(['Big']);
    expect(report.scenarios.a?.warnings).toEqual([
      'budget for component "Smal" (phase "load") never matched a rendered component; check the name.',
    ]);
  });
});

describe('render snapshot comparison (round-2 fixes)', async () => {
  const { compareSnapshot, toSnapshot } = await import('../src/report/snapshot.js');
  const make = (renders: number, avoidable: number, commits = 1) => {
    const c = component(renders, renders, avoidable);
    c.avoidableRenders = s(avoidable);
    const p = phase({ Item: c });
    p.commits = s(commits);
    return report({ interaction: p });
  };

  it('never hides a renders regression behind an avoidable improvement (R2-01)', () => {
    const r = compareSnapshot(toSnapshot(make(10, 10)), make(20, 0));
    expect(r.passed).toBe(false);
    expect(r.regressions.map((c) => [c.metric, c.expected, c.actual])).toEqual([
      ['renders', 10, 20],
    ]);
    expect(r.improvements.map((c) => c.metric)).toEqual(['avoidable']);
  });

  it('fails when commits grow (R2-11)', () => {
    const r = compareSnapshot(toSnapshot(make(10, 0, 2)), make(10, 0, 50));
    expect(r.regressions.map((c) => [c.metric, c.expected, c.actual])).toEqual([
      ['commits', 2, 50],
    ]);
  });

  it('stores flaky counts as ranges and only fails outside them (R2-14)', () => {
    const flaky = make(10, 0);
    const item = flaky.scenarios.home?.phases.interaction?.components.Item;
    if (item) item.renders = { median: 11, min: 10, max: 12 };
    const snap = toSnapshot(flaky);
    expect(snap.scenarios.home?.interaction?.components.Item?.renders).toEqual([10, 12]);
    expect(compareSnapshot(snap, make(12, 0)).passed).toBe(true);
    expect(compareSnapshot(snap, make(13, 0)).regressions[0]?.flaky).toBe(true);
  });
});

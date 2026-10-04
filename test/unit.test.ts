import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildReport, checkBudgets, stat } from '../src/report/aggregate.js';
import { compareReports } from '../src/report/compare.js';
import { compareToMarkdown, reportToMarkdown } from '../src/report/markdown.js';
import type { ComponentReport, CrispyReport, PhaseReport, RawRun } from '../src/types.js';
import { cmpNatural } from '../src/util/cmp.js';

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
    triggeredBy: {},
    recreatedContextFrom: {},
    providerAt: [],
    creators: {},
    staleMemo: {},
    compiled: false,
    memo: false,
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
      triggeredBy: {},
      recreatedContextFrom: {},
      memo: false,
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

describe('source maps', async () => {
  const { SourceMapResolver } = await import('../src/profiler/sourcemaps.js');

  it('resolves sectioned (index) source maps like Turbopack serves (R3-01)', async () => {
    const files: Record<string, string> = {
      'http://x.dev/chunk.js': 'console.log(1);\n//# sourceMappingURL=chunk.js.map',
      'http://x.dev/chunk.js.map': JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: { version: 3, sources: ['src/A.tsx'], names: [], mappings: 'AAKA' },
          },
        ],
      }),
    };
    const resolver = new SourceMapResolver(async (u) => files[u] ?? null, '/nonexistent');
    expect(await resolver.resolve('http://x.dev/chunk.js', 1, 1)).toEqual({
      file: 'src/A.tsx',
      line: 6,
    });
    expect(await resolver.rewriteLocation('http://x.dev/chunk.js:1:1 (App)')).toBe(
      'src/A.tsx:6 (App)',
    );
  });

  it('keeps absolute file paths readable (R3-10, R3-20)', async () => {
    const resolver = new SourceMapResolver(async () => null, '/nonexistent');
    expect(await resolver.rewriteLocation('/abs/src/main.jsx:8:1 (App)')).toBe(
      '/abs/src/main.jsx:8 (App)',
    );
    expect(await resolver.rewriteLocation('http://localhost:5173/@fs/abs/ui/Fancy.tsx:3:5')).toBe(
      '/abs/ui/Fancy.tsx:3',
    );
  });
});

describe('cmpNatural (R3-21)', () => {
  it('sorts line numbers numerically and deterministically', () => {
    const sites = [
      'src/App.tsx:10 (App)',
      'src/App.tsx:9 (App)',
      'src/App.tsx:100 (App)',
      'src/A.tsx:2',
    ];
    expect([...sites].sort(cmpNatural)).toEqual([
      'src/A.tsx:2',
      'src/App.tsx:9 (App)',
      'src/App.tsx:10 (App)',
      'src/App.tsx:100 (App)',
    ]);
    expect(cmpNatural('a01', 'a1')).not.toBe(0);
  });
});

describe('render snapshot churn (round-3 fixes)', async () => {
  const { compareSnapshot, mergeAdditions, toSnapshot } = await import('../src/report/snapshot.js');
  const withFile = (c: ComponentReport, file: string) => ({ ...c, definedIn: file });

  it('treats a pure rename as renamed, not as a regression (R3-06)', () => {
    const before = report({ interaction: phase({ Card: withFile(component(4), 'src/Card.tsx') }) });
    const after = report({
      interaction: phase({ ProductCard: withFile(component(4), 'src/Card.tsx') }),
    });
    const r = compareSnapshot(toSnapshot(before), after);
    expect(r.passed).toBe(true);
    expect(r.changes.map((c) => [c.status, c.renamedFrom, c.component])).toEqual([
      ['renamed', 'Card', 'ProductCard'],
    ]);
    // A rename with different counts is not a pure rename: old one gone, new one added.
    const changed = report({
      interaction: phase({ ProductCard: withFile(component(9), 'src/Card.tsx') }),
    });
    expect(compareSnapshot(toSnapshot(before), changed).changes.map((c) => c.status)).toEqual([
      'improved',
      'new',
    ]);
    expect(
      Object.keys(
        mergeAdditions(toSnapshot(before), after).scenarios.home?.interaction?.components ?? {},
      ),
    ).toEqual(['ProductCard']);
  });

  it('treats an unambiguous rename plus move to another file as renamed (R4-05)', () => {
    const before = report({ interaction: phase({ Card: withFile(component(4), 'src/Card.tsx') }) });
    const moved = report({
      interaction: phase({ ProductCard: withFile(component(4), 'src/shop/ProductCard.tsx') }),
    });
    expect(compareSnapshot(toSnapshot(before), moved).changes.map((c) => c.status)).toEqual([
      'renamed',
    ]);
    // Two candidates with identical counts: ambiguous, so no guess.
    const two = report({
      interaction: phase({
        A: withFile(component(4), 'src/a.tsx'),
        B: withFile(component(4), 'src/b.tsx'),
      }),
    });
    expect(compareSnapshot(toSnapshot(before), two).changes.map((c) => c.status)).not.toContain(
      'renamed',
    );
  });

  it('accepts new UI that updates and warns when it renders avoidably (R3-14, R4-05)', () => {
    const before = report({ interaction: phase({ App: component(1) }) });
    const updating = report({ interaction: phase({ App: component(1), Toast: component(3, 2) }) });
    const r = compareSnapshot(toSnapshot(before), updating);
    expect(r.passed).toBe(true);
    expect(r.additions.map((c) => c.component)).toEqual(['Toast']);
    const wasteful = report({
      interaction: phase({ App: component(1), Toast: component(3, 2, 2) }),
    });
    // Reported with a warning by default; fails only with failOnNewAvoidable (R4-05).
    const warned = compareSnapshot(toSnapshot(before), wasteful);
    expect(warned.passed).toBe(true);
    expect(warned.additions[0]?.warning).toBe(true);
    expect(compareSnapshot(toSnapshot(before), wasteful, 0, false, true).passed).toBe(false);
  });
});

describe('per-run key stabilization (R3-09)', async () => {
  const { stabilizeKeys } = await import('../src/report/aggregate.js');
  const raw = (renders: number) =>
    ({
      renders,
      mounts: renders,
      updates: 0,
      wastedRenders: 0,
      avoidableRenders: 0,
      changedProps: {},
      unstableProps: {},
      callbackProps: {},
      callbackRenders: 0,
      triggeredBy: {},
      recreatedContextFrom: {},
      memo: false,
      locations: {},
      causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: 0 },
      selfDurationMs: 0,
    }) as RawRun['phases'][string]['components'][string];
  const run = (definitions: Record<string, string>): RawRun => ({
    reactVersion: '19',
    profilingBuild: true,
    phases: { load: { commits: 1, components: { Item: raw(1), 'Item#2': raw(5) } } },
    vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
    warnings: [],
    definitions,
  });

  it('does not mix components whose numbered keys differ between runs', () => {
    // Run 2 loaded the modules in the other order, so `Item#2` is the other component.
    const { runs } = stabilizeKeys([
      run({ Item: 'src/a.tsx', 'Item#2': 'src/b.tsx' }),
      run({ Item: 'src/b.tsx', 'Item#2': 'src/a.tsx' }),
    ]);
    const counts = runs.map((r) =>
      Object.fromEntries(
        Object.entries(r.phases.load?.components ?? {}).map(([k, v]) => [k, v.renders]),
      ),
    );
    expect(counts).toEqual([
      { 'Item (src/a.tsx)': 1, 'Item (src/b.tsx)': 5 },
      { 'Item (src/b.tsx)': 1, 'Item (src/a.tsx)': 5 },
    ]);
  });
});

describe('Next.js internals (R4-01, R4-02)', async () => {
  const { SourceMapResolver } = await import('../src/profiler/sourcemaps.js');
  const { hideInternals } = await import('../src/report/aggregate.js');
  const map = (sources: string[]) =>
    // Split so test tooling does not mistake this literal for a real map comment.
    `x;\n//# source${'MappingURL'}=data:application/json,${encodeURIComponent(
      JSON.stringify({ version: 3, sources, names: [], mappings: 'AAKA' }),
    )}`;

  it('places library sources under node_modules, never on this machine', async () => {
    const files: Record<string, string> = {
      // Turbopack: Next's prebuilt dev overlay maps to its own repo layout.
      'http://x.dev/_next/static/chunks/0w6x_next_dist_compiled_index.js': map([
        'webpack://next/src/next-devtools/dev-overlay.tsx',
      ]),
      // webpack: Next's maps resolve to directories of the machine running the app.
      'webpack-internal:///(app-pages-browser)/./node_modules/next/dist/client/link.js': map([
        'webpack-internal:///tmp/someone/src/client/app-dir/link.tsx',
      ]),
      // App code keeps its project path.
      'http://x.dev/_next/static/chunks/components_List.js': map([
        'file:///repo/components/List.tsx',
      ]),
    };
    const resolver = new SourceMapResolver(async (u) => files[u] ?? null, '/repo');
    const at = (url: string) => resolver.resolve(url, 1, 1);
    expect(await at('http://x.dev/_next/static/chunks/0w6x_next_dist_compiled_index.js')).toEqual({
      file: 'node_modules/next/src/next-devtools/dev-overlay.tsx',
      line: 6,
    });
    expect(
      await at('webpack-internal:///(app-pages-browser)/./node_modules/next/dist/client/link.js'),
    ).toEqual({ file: 'node_modules/next/dist/client/link.js', line: 1 });
    expect(await at('http://x.dev/_next/static/chunks/components_List.js')).toEqual({
      file: 'components/List.tsx',
      line: 6,
    });
  });

  it('hides library-only roots and counts only commits with visible components', () => {
    const raw = (roots: string[], locations: Record<string, number> = {}) =>
      ({
        renders: 1,
        mounts: 1,
        updates: 0,
        wastedRenders: 0,
        avoidableRenders: 0,
        changedProps: {},
        unstableProps: {},
        callbackProps: {},
        callbackRenders: 0,
        triggeredBy: {},
        recreatedContextFrom: {},
        memo: false,
        locations,
        causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: 0 },
        selfDurationMs: 0,
        roots: Object.fromEntries(roots.map((r) => [r, 1])),
      }) as RawRun['phases'][string]['components'][string];
    const run: RawRun = {
      reactVersion: '19',
      profilingBuild: true,
      phases: {
        load: {
          commits: 5,
          components: {
            App: raw(['0.1']),
            Overlay: raw(['0.2']),
            // Rendered while navigating away: no definition, same overlay root.
            e4: raw(['0.2']),
          },
          commitKeys: { App: 1, 'Overlay\ne4': 3 },
        },
      },
      vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
      warnings: [],
      definitions: { App: 'app/page.tsx', Overlay: 'node_modules/next/src/overlay.tsx' },
    };
    const { runs, hidden } = hideInternals([run]);
    expect(Object.keys(runs[0]?.phases.load?.components ?? {})).toEqual(['App']);
    expect(runs[0]?.phases.load?.commits).toBe(1);
    expect(hidden).toBe(2);
  });
});

describe('snapshot update keeps flaky ranges (R4-06)', async () => {
  const { keepRanges } = await import('../src/report/snapshot.js');
  const snap = (commits: number | [number, number]) => ({
    schemaVersion: 1 as const,
    scenarios: { s: { p: { commits, components: {} } } },
  });
  it('widens overlapping ranges and replaces real changes', () => {
    expect(keepRanges(snap(12), snap([12, 16])).scenarios.s?.p?.commits).toEqual([12, 16]);
    expect(keepRanges(snap([13, 18]), snap([12, 16])).scenarios.s?.p?.commits).toEqual([12, 18]);
    expect(keepRanges(snap(3), snap([12, 16])).scenarios.s?.p?.commits).toBe(3);
    expect(keepRanges(snap(5), snap(4)).scenarios.s?.p?.commits).toBe(5);
  });
});

describe('fix hints that converge (R4-03..R4-10)', async () => {
  const { hintFor } = await import('../src/report/hints.js');
  const at = (c: ComponentReport) => ({ ...c, locations: ['src/Shop.tsx:25 (Shop)'] });

  it('names every recreated prop and the component that creates it', () => {
    const c = at(component(3));
    c.unstableProps = { style: 3 };
    c.callbackProps = { onAdd: 3 };
    c.creators = { 'style|Page': 3, 'onAdd|Shop': 3 };
    const hint = hintFor(c) ?? '';
    expect(hint).toContain('`style` is recreated with equal data in `Page`');
    expect(hint).toContain('`onAdd` is a new function with the same code in `Shop`');
  });

  it('points at the changing dependency of an existing useCallback', () => {
    const c = at(component(3));
    c.callbackProps = { onAdd: 3 };
    c.creators = { 'onAdd|Shop': 3 };
    c.staleMemo = { 'onAdd|Shop|#1 (an object)': 3 };
    expect(hintFor(c)).toContain(
      '`onAdd` is already memoized in `Shop`, but its dependency #1 (an object) changes',
    );
  });

  it('never tells library components or children-only renders to use React.memo', () => {
    const lib = at(component(3, 3, 3));
    lib.definedIn = 'node_modules/styled-components/dist/index.js';
    expect(hintFor(lib)).toContain('Nothing to change here');
    const kids = at(component(3));
    kids.unstableProps = { children: 3 };
    expect(hintFor(kids)).toContain('React.memo will not help');
  });

  it('only blames a state owner when its cascade has avoidable renders', () => {
    const owner = at(component(2));
    owner.causes.state = 2;
    const child = component(5);
    child.triggeredBy = { Shop: 5 };
    const necessary = phase({ Shop: owner, Row: child });
    expect(hintFor(owner, necessary, 'Shop')).not.toContain('avoidable render(s) below');
    child.avoidableRenders = s(5);
    expect(hintFor(owner, phase({ Shop: owner, Row: child }), 'Shop')).toContain(
      '5 avoidable render(s) below',
    );
  });
});

describe('library factory keys (R4-15)', async () => {
  const { stabilizeKeys } = await import('../src/report/aggregate.js');
  it('keys a single styled component by its site, so adding a second one renames nothing', () => {
    const c = {
      renders: 1,
      mounts: 1,
      updates: 0,
      wastedRenders: 0,
      avoidableRenders: 0,
      changedProps: {},
      unstableProps: {},
      callbackProps: {},
      callbackRenders: 0,
      triggeredBy: {},
      recreatedContextFrom: {},
      memo: false,
      locations: { 'src/Card.tsx:27 (ProductCard)': 1 },
      causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: 0 },
      selfDurationMs: 0,
    } as RawRun['phases'][string]['components'][string];
    const { runs } = stabilizeKeys([
      {
        reactVersion: '19',
        profilingBuild: true,
        phases: { load: { commits: 1, components: { 'styled.div': c } } },
        vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
        warnings: [],
        definitions: { 'styled.div': 'node_modules/styled-components/dist/index.js' },
      },
    ]);
    expect(Object.keys(runs[0]?.phases.load?.components ?? {})).toEqual([
      'styled.div @ src/Card.tsx:27',
    ]);
  });
});

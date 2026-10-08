import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildReport, checkBudgets, stat } from '../src/report/aggregate.js';
import { compareReports } from '../src/report/compare.js';
import { compareToMarkdown, reportToMarkdown } from '../src/report/markdown.js';
import type { ComponentReport, CrispyReport, PhaseReport, RawRun } from '../src/types.js';
import { cmpNatural } from '../src/util/cmp.js';
import { freePort } from './helpers.js';

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
    stateChanges: {},
    providerAt: [],
    creators: {},
    staleMemo: {},
    compiled: false,
    memo: false,
    memoSkips: 0,
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

describe('compare for agents (council round 4)', () => {
  it('follows renames, counts callback renders as avoidable and reports ms', async () => {
    const { compareReports } = await import('../src/report/compare.js');
    const { compareToMarkdown } = await import('../src/report/markdown.js');
    const row = component(10, 10, 0);
    row.callbackRenders = s(10);
    row.definedIn = 'src/Row.tsx';
    const base = report({ interaction: phase({ Row: row }) });
    const bp = base.scenarios.home?.phases.interaction;
    if (bp) {
      bp.totalCallbackRenders = s(10);
      bp.cost = { scriptMs: s(120), taskMs: s(150) } as never;
    }
    const memoRow = { ...component(10, 10, 0), definedIn: 'src/Row.tsx', memo: true };
    const head = report({ interaction: phase({ Row2: memoRow }) });
    const hp = head.scenarios.home?.phases.interaction;
    if (hp) hp.cost = { scriptMs: s(48), taskMs: s(60) } as never;
    const r = compareReports(base, head);
    expect(
      r.diffs.map((d) => [d.component, d.renamedFrom, d.baseAvoidable, d.headAvoidable]),
    ).toEqual([['Row2', 'Row', 10, 0]]);
    expect(r.totals.baseAvoidable).toBe(10);
    const md = compareToMarkdown(r);
    expect(md).toContain('Row → Row2');
    expect(md).toContain('JavaScript: 120 → 48 ms (-60%');
  });
});

describe('compare with a missing scenario (council round 3)', () => {
  it('lists it as not compared instead of -100% improvements', async () => {
    const { compareReports } = await import('../src/report/compare.js');
    const { compareToMarkdown } = await import('../src/report/markdown.js');
    const base = report({ interaction: phase({ Item: component(10) }) });
    const head = report({});
    const r = compareReports(base, head);
    expect(r.improvements).toEqual([]);
    expect(r.notCompared).toEqual(['home / interaction (only in base)']);
    expect(compareToMarkdown(r)).toContain('Not compared (ran on one side only)');
  });
});

describe('config typos (council round 3)', () => {
  it('rejects unknown keys and suggests the right one', async () => {
    const { parseConfig } = await import('../src/config.js');
    expect(() =>
      parseConfig({
        baseUrl: 'http://localhost:5173',
        readonly: true,
        scenarios: [{ name: 'a', step: [] }],
      }),
    ).toThrow(
      /unknown key "readonly" \(did you mean "readOnly"\?\)[\s\S]*"step" in scenario "a" \(did you mean "steps"\?\)/,
    );
  });

  it('rejects typos inside steps instead of ignoring them (round 5)', async () => {
    const { parseConfig } = await import('../src/config.js');
    const config = (steps: unknown[]) => ({
      baseUrl: 'http://localhost:5173',
      scenarios: [{ name: 'a', steps }],
    });
    // A misspelled key on an expect step used to pass, so a frozen UI went green.
    expect(() => parseConfig(config([{ action: 'expect', selector: '#n', cuont: 3 }]))).toThrow(
      /unknown key "cuont" in "expect" in scenario "a" \(step 1\) \(did you mean "count"\?\)/,
    );
    expect(() => parseConfig(config([{ action: 'clik', selector: '#go' }]))).toThrow(
      /unknown action "clik" in scenario "a" \(step 1\) \(did you mean "click"\?\)/,
    );
    expect(() => parseConfig(config([{ action: 'banana' }]))).toThrow(/use one of click, /);
    // Valid steps still parse.
    expect(() =>
      parseConfig(
        config([
          { action: 'click', selector: '#go' },
          { action: 'phase', name: 'x' },
        ]),
      ),
    ).not.toThrow();
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

  it('reports the same renders becoming avoidable as 🟡, not a regression (council round 1)', () => {
    const r = compareSnapshot(toSnapshot(make(25, 0)), make(25, 25));
    expect(r.passed).toBe(true);
    expect(r.changes.map((c) => [c.metric, c.uncovered])).toEqual([['avoidable', true]]);
    // More renders that are also more avoidable is still a regression.
    expect(compareSnapshot(toSnapshot(make(10, 0)), make(25, 25)).passed).toBe(false);
    // Strict mode fails on it.
    expect(
      compareSnapshot(toSnapshot(make(25, 0)), make(25, 25), 0, false, false, true).passed,
    ).toBe(false);
  });

  it('counts recreated-callback renders as avoidable, so they never read as 🟢 (council round 2)', () => {
    const before = make(10, 2);
    const after = make(10, 0);
    const item = after.scenarios.home?.phases.interaction?.components.Item;
    if (item) item.callbackRenders = s(2);
    const r = compareSnapshot(toSnapshot(before), after);
    expect(r.changes).toEqual([]);
  });

  it('reports more commits, and fails on them only when asked (R2-11, council round 3)', () => {
    const r = compareSnapshot(toSnapshot(make(10, 0, 2)), make(10, 0, 50));
    expect(r.passed).toBe(true);
    expect(r.changes.map((c) => [c.metric, c.expected, c.actual, c.info])).toEqual([
      ['commits', 2, 50, true],
    ]);
    const strict = compareSnapshot(
      toSnapshot(make(10, 0, 2)),
      make(10, 0, 50),
      0,
      false,
      false,
      false,
      true,
    );
    expect(strict.regressions.map((c) => [c.metric, c.expected, c.actual])).toEqual([
      ['commits', 2, 50],
    ]);
  });

  it('reports one cause once, however many rows it regresses (council round 2)', async () => {
    const { snapshotToMarkdown } = await import('../src/report/snapshot.js');
    const tree = (renders: number) => {
      const parent = component(renders, renders, 0);
      parent.causes.state = renders;
      const child = component(renders, renders, renders - 1);
      child.avoidableRenders = s(renders - 1);
      child.triggeredBy = { Parent: renders };
      const grand = component(renders, renders, renders - 1);
      grand.avoidableRenders = s(renders - 1);
      grand.triggeredBy = { Child: renders };
      return report({ interaction: phase({ Parent: parent, Child: child, Grand: grand }) });
    };
    const r = compareSnapshot(toSnapshot(tree(1)), tree(10));
    expect(r.regressions.length).toBe(5);
    expect(r.regressions.filter((c) => c.component !== 'Parent').map((c) => c.rootCause)).toEqual([
      'Parent',
      'Parent',
      'Parent',
      'Parent',
    ]);
    const md = snapshotToMarkdown(r, 'crispy.snap.json');
    expect(md).toContain('❌ 5 render regression(s) from 1 cause');
    expect(md.split('\n').filter((l) => l.startsWith('| ❌'))).toHaveLength(1);
    expect(md).toContain('Parent, which re-renders Child, Grand');
  });

  it('flags fewer renders on a mutable-instance reader instead of 🟢 (council round 3)', async () => {
    const { keepRanges, serializeSnapshot, snapshotToMarkdown } = await import(
      '../src/report/snapshot.js'
    );
    const before = make(6, 0);
    const item = before.scenarios.home?.phases.interaction?.components.Item;
    if (item) item.instanceProps = { table: 6 };
    const snap = toSnapshot(before);
    expect(serializeSnapshot(snap)).toContain('"mutable": true');
    const r = compareSnapshot(snap, make(0, 0));
    expect(r.improvements.map((c) => c.suspect)).toEqual([true]);
    const md = snapshotToMarkdown(r, 'crispy.snap.json');
    expect(md).toContain('⚠️ check the UI');
    // No green heading and no "lock it in" nudge next to a possibly frozen UI.
    expect(md).toContain('⚠️ no render regressions, but check the UI');
    expect(md).not.toContain('✅ no render regressions');
    expect(md).not.toContain('Improvements found');
    // Accepting the drop keeps the flag, though the component no longer renders.
    expect(
      keepRanges(toSnapshot(make(0, 0)), snap).scenarios.home?.interaction?.components.Item
        ?.mutable,
    ).toBe(true);
  });

  it('flags a renamed mutable-instance reader, the usual trace of a new React.memo (council round 3)', async () => {
    const { snapshotToMarkdown } = await import('../src/report/snapshot.js');
    const before = make(4, 0);
    const item = before.scenarios.home?.phases.interaction?.components.Item;
    if (item) {
      item.instanceProps = { table: 4 };
      item.definedIn = 'src/Bulk.tsx';
    }
    const snap = toSnapshot(before);
    const after = make(4, 0);
    const p = after.scenarios.home?.phases.interaction;
    const moved = p?.components.Item;
    if (p && moved) {
      moved.definedIn = 'src/Bulk.tsx';
      p.components.ItemImpl = { ...moved, memo: true };
      delete p.components.Item;
    }
    const r = compareSnapshot(snap, after);
    expect(r.changes.map((c) => [c.status, c.suspect])).toEqual([['renamed', true]]);
    expect(snapshotToMarkdown(r, 'crispy.snap.json')).toContain('⚠️ check the UI');
  });

  it('leaves node_modules components out of snapshots by default (council round 3)', () => {
    const withIcon = (renders: number) => {
      const r = make(10, 0);
      const p = r.scenarios.home?.phases.interaction;
      if (p) {
        p.components.Icon = component(renders);
        p.components.Icon.definedIn = 'node_modules/lucide-react/dist/esm/createLucideIcon.js';
      }
      return r;
    };
    expect(
      Object.keys(toSnapshot(withIcon(3)).scenarios.home?.interaction?.components ?? {}),
    ).toEqual(['Item']);
    // An old snapshot that still lists it: neither a change nor a removal.
    const old = toSnapshot(withIcon(3), true);
    expect(compareSnapshot(old, withIcon(9)).changes).toEqual([]);
    // Opt in to compare them.
    const strict = compareSnapshot(old, withIcon(9), 0, false, false, false, false, true);
    expect(strict.regressions.map((c) => c.component)).toEqual(['Icon']);
  });

  it('folds a regression rendered by another regressed component into its cause (council round 3)', async () => {
    const { snapshotToMarkdown } = await import('../src/report/snapshot.js');
    const tree = (renders: number) => {
      const sidebar = component(renders, renders, 0);
      sidebar.causes.state = renders;
      const nav = component(renders, renders, 0);
      nav.locations = ['src/AppSidebar.tsx:12 (Sidebar)'];
      const link = component(renders, renders, 0);
      link.locations = ['src/Nav.tsx:4 (Nav)'];
      return report({ interaction: phase({ Sidebar: sidebar, Nav: nav, Link: link }) });
    };
    const r = compareSnapshot(toSnapshot(tree(1)), tree(5));
    expect(r.regressions.filter((c) => c.component !== 'Sidebar').map((c) => c.rootCause)).toEqual([
      'Sidebar',
      'Sidebar',
    ]);
    expect(snapshotToMarkdown(r, 'crispy.snap.json')).toContain('from 1 cause');
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

  it('never says React.memo helps a component that gets new children JSX (council round 2)', () => {
    const c = at(component(4));
    c.callbackProps = { onClick: 4 };
    c.creators = { 'onClick|Toolbar': 4 };
    c.unstableProps = { children: 4 };
    const hint = hintFor(c) ?? '';
    expect(hint).toContain('React.memo will not help yet');
    expect(hint).not.toContain('Then wrap this component in React.memo');
  });

  it('never suggests a hook inside a render function such as a TanStack cell (council round 3)', async () => {
    const { rootCauses } = await import('../src/report/hints.js');
    const box = at(component(5, 5, 0));
    box.callbackRenders = s(5);
    box.callbackProps = { onCheckedChange: 5 };
    box.creators = { 'onCheckedChange|cell': 5 };
    const hint = hintFor(box) ?? '';
    expect(hint).toContain('a render function where hooks are not allowed');
    expect(hint).not.toContain('wrap it in useCallback with the values');
    const causes = rootCauses(phase({ Checkbox: box }));
    expect(causes[0]?.text).toContain('`cell` is a render function where hooks are not allowed');
  });

  it('points at the changing dependency of an existing useCallback', () => {
    const c = at(component(3));
    c.callbackProps = { onAdd: 3 };
    c.creators = { 'onAdd|Shop': 3 };
    c.staleMemo = { 'onAdd|Shop|#1 (an object)': 3 };
    expect(hintFor(c)).toContain(
      '`onAdd` in `Shop` is memoized, but its dependency #1 (an object) is recreated on every render',
    );
  });

  it('tells a child to fix its avoidably re-rendering parent first (council round 1)', () => {
    const price = { ...component(3, 3, 3), locations: ['src/Row.tsx:9 (ProductRow)'] };
    const row = component(3, 3, 3);
    row.unstableProps = { style: 3 };
    const p = phase({ Price: price, ProductRow: row });
    const hint = hintFor(price, p, 'Price') ?? '';
    expect(hint).toContain('fix `ProductRow` first');
    expect(hint).not.toContain('wrap it in React.memo, or');
    // A parent whose renders are necessary: React.memo on the child is still the advice.
    const needed = phase({ Price: price, ProductRow: component(3, 3, 0) });
    expect(hintFor(price, needed, 'Price')).toContain('wrap it in React.memo');
  });

  it('does not list derived data recomputed from a real change as a root cause (council round 2)', async () => {
    const { rootCauses } = await import('../src/report/hints.js');
    const row = component(3, 3, 0);
    row.unstableProps = { items: 3 };
    row.creators = { 'items|App': 3 };
    row.staleMemo = { 'items|App|`query` (string)': 3 };
    row.avoidableRenders = s(3);
    const p = phase({ Row: row, App: component(1, 1, 0) });
    expect(
      rootCauses(p)
        .map((c) => c.text)
        .join('\n'),
    ).not.toContain('`App` recreates');
    expect(hintFor(row, p, 'Row')).toContain('useDeferredValue');
  });

  it('calls a primitive dependency a real change, not something to stabilize', () => {
    const c = at(component(3));
    c.callbackProps = { onAdd: 3 };
    c.creators = { 'onAdd|Shop': 3 };
    c.staleMemo = { 'onAdd|Shop|`query` (string)': 3 };
    const hint = hintFor(c) ?? '';
    expect(hint).toContain('its dependency `query` (string) really changed');
    expect(hint).toContain('read that value when the callback runs');
    expect(hint).not.toContain('memoize it where it is created');
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

describe('zero-config setup', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { detectApp } = await import('../src/detect.js');
  const { isUp, startWebServer } = await import('../src/profiler/webserver.js');

  it('detects framework, port and dev command from package.json', () => {
    const app = (pkg: object, lock?: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'crispy-detect-'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      if (lock) writeFileSync(join(dir, lock), '');
      return detectApp(dir);
    };
    expect(
      app({ dependencies: { next: '16' }, scripts: { dev: 'next dev' } }, 'pnpm-lock.yaml'),
    ).toEqual({
      framework: 'next',
      baseUrl: 'http://localhost:3000',
      devCommand: 'pnpm run dev',
    });
    expect(app({ devDependencies: { vite: '8' }, scripts: { dev: 'vite --port 5180' } })).toEqual({
      framework: 'vite',
      baseUrl: 'http://localhost:5180',
      devCommand: 'npm run dev',
    });
    expect(app({})).toEqual({
      framework: 'unknown',
      baseUrl: 'http://localhost:5173',
      devCommand: null,
    });
  });

  it('starts the dev server, waits for it and stops it', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const command = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port})"`;
    const { stop } = await startWebServer({ command, timeoutMs: 10_000, reuseExisting: true }, url);
    expect(await isUp(url)).toBe(true);
    await stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(await isUp(url)).toBe(false);
  });

  it('explains a dev server that exits', async () => {
    await expect(
      startWebServer(
        { command: 'node -e "process.exit(3)"', timeoutMs: 10_000, reuseExisting: false },
        'http://127.0.0.1:47999',
      ),
    ).rejects.toThrow(/exited with code 3/);
  });
});

describe('root causes (R5-05, R5-06)', async () => {
  const { rootCauses } = await import('../src/report/hints.js');
  it('groups avoidable renders by cause and finds the best React.memo boundary', () => {
    const row = component(20, 20, 0);
    row.callbackRenders = s(20);
    row.creators = { 'onSelect|App': 20 };
    const list = component(4, 4, 4);
    list.triggeredBy = { App: 4 };
    list.locations = ['src/App.tsx:10 (App)'];
    const item = component(9, 9, 9);
    item.triggeredBy = { App: 9 };
    item.locations = ['src/List.tsx:5 (List)'];
    const app = component(1, 1, 0);
    app.causes.state = 1;
    const causes = rootCauses(phase({ App: app, Row: row, List: list, Item: item }));
    expect(causes.map((c) => c.renders)).toEqual([20, 13]);
    expect(causes[0]?.text).toContain(
      '`App` recreates `onSelect` → 20 avoidable render(s) in `Row`',
    );
    expect(causes[1]?.text).toContain('Wrapping `List` in React.memo would skip 13 of them');
  });

  it('warns that useCallback cannot go inside a .map when the function is made per item', () => {
    const row = component(20, 20, 0);
    row.callbackRenders = s(20);
    row.callbackProps = { onSelect: 20 };
    row.creators = { 'onSelect|App': 20 };
    const app = component(1, 1, 0);
    app.causes.state = 1;
    const text = rootCauses(phase({ App: app, Row: row }))[0]?.text ?? '';
    expect(text).toContain('wrap them in useCallback there');
    expect(text).toContain('inside a `.map`, hooks are not allowed in a loop');
    // One instance per parent render: a plain useCallback is right, no loop warning.
    const single = component(12, 12, 0);
    single.callbackRenders = s(12);
    single.callbackProps = { onSelect: 12 };
    single.creators = { 'onSelect|App': 12 };
    const parent = component(12, 12, 0);
    parent.causes.state = 12;
    const text2 = rootCauses(phase({ App: parent, Row: single }))[0]?.text ?? '';
    expect(text2).toContain('wrap them in useCallback there');
    expect(text2).not.toContain('.map');
  });
});

describe('root causes never double count (R6-03)', async () => {
  const { rootCauses } = await import('../src/report/hints.js');
  it('attributes each avoidable render once and skips library creators', () => {
    const row = component(4, 4, 0);
    row.callbackRenders = s(4);
    // One parent recreates two props of the same rows: one cause, 4 renders.
    row.creators = { 'style|Grid': 4, 'onPick|Grid': 4 };
    const btn = component(10, 10, 0);
    btn.callbackRenders = s(10);
    // Several owners recreate props of the same button: still at most 10.
    btn.creators = { 'onClick|A': 10, 'icon|B': 6, 'ref|SlotClone': 10 };
    const p = phase({ Row: row, Button: btn });
    p.library = ['SlotClone'];
    const causes = rootCauses(p);
    const total = causes.reduce((a, c) => a + c.renders, 0);
    expect(total).toBeLessThanOrEqual(14);
    expect(causes.some((c) => c.text.includes('SlotClone'))).toBe(false);
    expect(causes.find((c) => c.text.includes('`Grid` recreates'))?.text).toContain(
      '`Grid` recreates `style`, `onPick` → 4 avoidable render(s) in `Row`',
    );
    // 4 renders, but a large share of this small phase: not optional.
    expect(causes.find((c) => c.text.includes('`Grid` recreates'))?.minor).toBeUndefined();
  });
});

describe('dev server lifecycle (R6-04, R6-07)', async () => {
  const { spawn } = await import('node:child_process');
  const { isUp, startWebServer } = await import('../src/profiler/webserver.js');

  it('stops the dev server when crispy is interrupted', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/start-server.ts', String(port)],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    await new Promise<void>((done) =>
      child.stdout?.on('data', (d) => String(d).includes('ready') && done()),
    );
    expect(await isUp(`http://127.0.0.1:${port}`)).toBe(true);
    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 2000));
    expect(await isUp(`http://127.0.0.1:${port}`)).toBe(false);
  }, 30_000);

  it('refuses to profile whatever already runs on the port unless reuse is allowed', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const command = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port})"`;
    const { stop } = await startWebServer(
      { command, timeoutMs: 10_000, reuseExisting: false },
      url,
    );
    try {
      await expect(
        startWebServer({ command, timeoutMs: 5000, reuseExisting: false }, url),
      ).rejects.toThrow(/already running/);
    } finally {
      await stop();
    }
  });
});

describe('reuses only a server that serves this app (council round 1)', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startWebServer } = await import('../src/profiler/webserver.js');
  it('refuses another app on the port even when reuse is allowed', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const other = `node -e "require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({name:'other-app'}))}).listen(${port})"`;
    const { stop } = await startWebServer(
      { command: other, timeoutMs: 10_000, reuseExisting: false },
      url,
    );
    const mine = mkdtempSync(join(tmpdir(), 'crispy-mine-'));
    writeFileSync(join(mine, 'package.json'), JSON.stringify({ name: 'my-app' }));
    try {
      await expect(
        startWebServer({ command: 'true', timeoutMs: 5000, reuseExisting: true, cwd: mine }, url),
      ).rejects.toThrow(/Another app \("other-app"\) is running/);
    } finally {
      await stop();
    }
  });
});

describe('real-world app detection (R6-06)', async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { detectApp } = await import('../src/detect.js');
  const { startWebServer } = await import('../src/profiler/webserver.js');
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'crispy-detect-'));
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    return dir;
  };

  it('reads ports from vite.config and .env, and ignores ports of other processes', () => {
    const vite = { devDependencies: { vite: '8' }, scripts: { dev: 'vite' } };
    expect(
      detectApp(
        project({
          'package.json': JSON.stringify(vite),
          'vite.config.ts': 'export default { server: { port: 3005 } }',
        }),
      ).baseUrl,
    ).toBe('http://localhost:3005');
    // Vite ignores PORT; Next.js reads it.
    expect(
      detectApp(project({ 'package.json': JSON.stringify(vite), '.env': 'PORT=4100\n' })).baseUrl,
    ).toBe('http://localhost:5173');
    const next = { dependencies: { next: '16' }, scripts: { dev: 'next dev' } };
    expect(
      detectApp(project({ 'package.json': JSON.stringify(next), '.env': 'PORT=4100\n' })).baseUrl,
    ).toBe('http://localhost:4100');
    const both = {
      devDependencies: { vite: '8' },
      scripts: { dev: 'concurrently "api --port 8080" "vite"' },
    };
    expect(detectApp(project({ 'package.json': JSON.stringify(both) })).baseUrl).toBe(
      'http://localhost:5173',
    );
  });

  it('uses the workspace package manager and skips install prefixes', () => {
    const root = project({
      'yarn.lock': '',
      'package.json': JSON.stringify({ devDependencies: { vite: '8' } }),
    });
    const app = join(root, 'app');
    mkdirSync(app);
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ scripts: { start: 'yarn && vite' } }),
    );
    expect(detectApp(app)).toEqual({
      framework: 'vite',
      baseUrl: 'http://localhost:5173',
      devCommand: 'yarn vite',
    });
  });

  it('follows the URL the dev server prints when the configured one never answers', async () => {
    const port = await freePort();
    const command = `node -e "require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('ok')}).listen(${port},()=>console.log('Local: http://localhost:${port}/'))"`;
    const server = await startWebServer(
      { command, timeoutMs: 10_000, reuseExisting: false },
      `http://localhost:${await freePort()}`,
    );
    try {
      expect(server.url).toBe(`http://localhost:${port}/`);
    } finally {
      await server.stop();
    }
  });
});

describe('environment values in steps (R6-17)', async () => {
  const { withEnv } = await import('../src/profiler/run.js');
  it('reads environment placeholders and keeps escaped ones literal', () => {
    process.env.CRISPY_UNIT_SECRET = 's3cret';
    const placeholder = '$' + '{CRISPY_UNIT_SECRET}';
    expect(withEnv(`pw: ${placeholder} / $${placeholder}`)).toBe(`pw: s3cret / ${placeholder}`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: crispy's own placeholder syntax
    expect(() => withEnv('${CRISPY_UNIT_MISSING}')).toThrow(/CRISPY_UNIT_MISSING is not set/);
  });
});

describe('dev server URL fallback is safe (R7-02, R7-03)', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startWebServer } = await import('../src/profiler/webserver.js');

  it('keeps the configured URL when an API announces itself first', async () => {
    const api = await freePort();
    const app = await freePort();
    const script = join(mkdtempSync(join(tmpdir(), 'crispy-ws-')), 'both.cjs');
    writeFileSync(
      script,
      `const http = require('http');
       http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end('{}'); })
         .listen(${api}, () => console.log('API listening on http://localhost:${api}'));
       setTimeout(() => http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('app'); })
         .listen(${app}, () => console.log('Local: http://localhost:${app}/')), 1500);`,
    );
    const server = await startWebServer(
      { command: `node ${script}`, timeoutMs: 15_000, reuseExisting: false },
      `http://localhost:${app}`,
    );
    try {
      expect(server.url).toBe(`http://localhost:${app}`);
    } finally {
      await server.stop();
    }
  });

  it('says the server did not answer when it times out (not that it exited)', async () => {
    await expect(
      startWebServer(
        { command: 'echo booting; sleep 100', timeoutMs: 3000, reuseExisting: false },
        `http://localhost:${await freePort()}`,
      ),
    ).rejects.toThrow(/did not answer/);
  });
});

describe('scan safety', async () => {
  const { RISKY } = await import('../src/scan.js');
  it('never clicks actions with effects outside the page', () => {
    const risky = new RegExp(RISKY, 'iu');
    for (const name of [
      'Delete',
      'Remove item',
      'Log out',
      'Sign out',
      'Pay now',
      'Checkout',
      'Send message',
      'Reset password',
      'Clear all',
      'Sign-out',
      'Eliminar',
      'Supprimer',
      'Löschen',
      'Cerrar sesión',
      'Delete account',
    ])
      expect(risky.test(name), name).toBe(true);
    for (const name of [
      'Add item',
      'Settings',
      'Next page',
      'Filter',
      'Toggle theme',
      'Open menu',
      'Log',
      'Account',
      'Blocks',
      'Orders list',
    ])
      expect(risky.test(name), name).toBe(false);
  });
});

describe('source names instead of bundler names (council round 4)', async () => {
  const { applySourceNames } = await import('../src/report/aggregate.js');
  const comp = (renders: number) =>
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
  const run = (
    components: Record<string, number>,
    sourceNames?: Record<string, string>,
  ): RawRun => ({
    reactVersion: '19',
    profilingBuild: true,
    phases: {
      load: {
        commits: 1,
        components: Object.fromEntries(Object.entries(components).map(([k, n]) => [k, comp(n)])),
      },
    },
    vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
    warnings: [],
    definitions: Object.fromEntries(Object.keys(components).map((k) => [k, 'src/Team.tsx'])),
    ...(sourceNames && { sourceNames }),
  });
  const keys = (r: RawRun) => Object.keys(r.phases.load?.components ?? {});

  it('shows Member instead of the Member2 the bundler produced', () => {
    const [r] = applySourceNames([run({ Member2: 8 }, { Member2: 'Member' })]);
    expect(keys(r as RawRun)).toEqual(['Member']);
    expect(Object.keys((r as RawRun).definitions ?? {})).toEqual(['Member']);
  });

  it('keeps the numbered suffix of same-named components', () => {
    const [r] = applySourceNames([
      run({ Member2: 1, 'Member2#2': 2 }, { Member2: 'Member', 'Member2#2': 'Member' }),
    ]);
    expect(keys(r as RawRun)).toEqual(['Member', 'Member#2']);
  });

  it('does not rename onto a name another component already has', () => {
    const [r] = applySourceNames([run({ Member: 1, Member2: 8 }, { Member2: 'Member' })]);
    expect(keys(r as RawRun)).toEqual(['Member', 'Member2']);
  });

  it('leaves runs without source names untouched', () => {
    const input = [run({ Member2: 8 })];
    expect(applySourceNames(input)).toBe(input);
  });
});

describe('read-only WebSocket guard (council round 5)', async () => {
  const { isHotReloadSocket } = await import('../src/profiler/run.js');
  it('exempts only the dev servers hot-reload sockets', () => {
    for (const hot of [
      '/?token=aB3dE5gH7jK9',
      '/_next/webpack-hmr',
      '/sockjs-node/123/x/websocket',
    ]) {
      expect(isHotReloadSocket(hot), hot).toBe(true);
    }
    // An app's own sockets stay guarded, even on common names or with a token in the query.
    for (const app of [
      '/ws',
      '/ws/',
      '/socket',
      '/socket.io/?EIO=4',
      '/chat?token=abc',
      '/live',
      '/',
    ]) {
      expect(isHotReloadSocket(app), app).toBe(false);
    }
  });
});

import { type Budget, type CrispyConfig, phasesOf, type Scenario } from '../config.js';
import type {
  BudgetViolation,
  ComponentReport,
  CrispyReport,
  PhaseReport,
  RawComponentStats,
  RawRun,
  ScenarioReport,
  Stat,
} from '../types.js';
import { cmp, cmpNatural } from '../util/cmp.js';
import { LIBRARY_FILE } from '../util/paths.js';
import { VERSION } from '../version.js';

const round = (n: number) => Math.round(n * 100) / 100;

export function stat(values: number[]): Stat {
  if (values.length === 0) return { median: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    median: round(median),
    min: round(sorted[0] as number),
    max: round(sorted[sorted.length - 1] as number),
  };
}

const medianOf = (values: number[]) => stat(values).median;

/** Most likely-avoidable renders first (what to fix), then most renders, then name. */
function byPriority(a: [string, ComponentReport], b: [string, ComponentReport]): number {
  const fixable = (c: ComponentReport) => c.avoidableRenders.median + c.callbackRenders.median;
  return (
    fixable(b[1]) - fixable(a[1]) || b[1].renders.median - a[1].renders.median || cmp(a[0], b[0])
  );
}

function medianCounts(
  samples: (RawComponentStats | undefined)[],
  get: (s: RawComponentStats) => Record<string, number> | undefined,
): Record<string, number> {
  const keys = new Set<string>();
  for (const s of samples) for (const k of Object.keys((s && get(s)) ?? {})) keys.add(k);
  const entries = [...keys]
    .map((k) => [k, medianOf(samples.map((s) => (s && get(s)?.[k]) ?? 0))] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || cmpNatural(a[0], b[0]));
  return Object.fromEntries(entries);
}

function aggregateComponent(
  samples: (RawComponentStats | undefined)[],
  timings: boolean,
): ComponentReport {
  const pick = (f: (s: RawComponentStats) => number) => samples.map((s) => (s ? f(s) : 0));
  const renders = stat(pick((s) => s.renders));

  const report: ComponentReport = {
    renders,
    mounts: stat(pick((s) => s.mounts)),
    updates: stat(pick((s) => s.updates)),
    wastedRenders: stat(pick((s) => s.wastedRenders)),
    avoidableRenders: stat(pick((s) => s.avoidableRenders ?? 0)),
    causes: {
      props: medianOf(pick((s) => s.causes.props)),
      state: medianOf(pick((s) => s.causes.state)),
      context: medianOf(pick((s) => s.causes.context)),
      unstable: medianOf(pick((s) => s.causes.unstable ?? 0)),
      callback: medianOf(pick((s) => s.causes.callback ?? 0)),
      parent: medianOf(pick((s) => s.causes.parent)),
    },
    changedProps: medianCounts(samples, (s) => s.changedProps),
    unstableProps: medianCounts(samples, (s) => s.unstableProps),
    callbackProps: medianCounts(samples, (s) => s.callbackProps),
    callbackRenders: stat(pick((s) => s.callbackRenders ?? 0)),
    triggeredBy: medianCounts(samples, (s) => s.triggeredBy),
    recreatedContextFrom: medianCounts(samples, (s) => s.recreatedContextFrom),
    stateChanges: medianCounts(samples, (s) => s.stateChanges),
    providerAt: Object.keys(medianCounts(samples, (s) => s.providerAt)).slice(0, 3),
    creators: medianCounts(samples, (s) => s.creators),
    staleMemo: medianCounts(samples, (s) => s.staleMemo),
    compiled: samples.some((s) => s?.compiled),
    memo: samples.some((s) => s?.memo),
    memoSkips: 0,
    locations: Object.keys(medianCounts(samples, (s) => s.locations)).slice(0, 3),
    stable: renders.min === renders.max,
  };
  const cascades = medianCounts(samples, (s) => s.effectCascades);
  if (Object.keys(cascades).length) {
    report.effectCascades = cascades;
    report.cascadeCommits = medianOf(pick((s) => s.cascadeCommits ?? 0));
    report.cascadeRenders = medianOf(pick((s) => s.cascadeRenders ?? 0));
  }
  const inCascades = medianOf(pick((s) => s.inEffectCascades ?? 0));
  if (inCascades > 0) report.inEffectCascades = inCascades;
  const masked = medianCounts(samples, (s) => s.maskedContextFrom);
  if (Object.keys(masked).length) report.maskedContextFrom = masked;
  const mutable = medianOf(pick((s) => s.mutableReads ?? 0));
  if (mutable > 0) report.mutableReads = mutable;
  const instances = medianCounts(samples, (s) => s.instanceProps);
  if (Object.keys(instances).length) report.instanceProps = instances;
  if (timings) report.selfDurationMs = stat(pick((s) => s.selfDurationMs));
  return report;
}

function aggregatePhase(runs: RawRun[], phase: string, config: CrispyConfig): PhaseReport {
  const names = new Set<string>();
  for (const r of runs)
    for (const n of Object.keys(r.phases[phase]?.components ?? {})) names.add(n);

  const entries = [...names]
    .map(
      (n) =>
        [
          n,
          aggregateComponent(
            runs.map((r) => r.phases[phase]?.components[n]),
            config.timings,
          ),
        ] as [string, ComponentReport],
    )
    .sort(byPriority);

  const totals = (f: (s: RawComponentStats) => number) =>
    stat(
      runs.map((r) =>
        Object.values(r.phases[phase]?.components ?? {}).reduce((acc, s) => acc + f(s), 0),
      ),
    );
  const report: PhaseReport = {
    commits: stat(runs.map((r) => r.phases[phase]?.commits ?? 0)),
    totalRenders: totals((s) => s.renders),
    totalWastedRenders: totals((s) => s.wastedRenders),
    totalAvoidableRenders: totals((s) => s.avoidableRenders ?? 0),
    totalCallbackRenders: totals((s) => s.callbackRenders ?? 0),
    components: {},
  };
  report.components = Object.fromEntries(entries);
  if (config.timings && runs.some((r) => r.cost?.[phase])) {
    report.cost = {
      scriptMs: stat(runs.map((r) => r.cost?.[phase]?.scriptMs ?? 0)),
      taskMs: stat(runs.map((r) => r.cost?.[phase]?.taskMs ?? 0)),
    };
  }
  return report;
}

export function checkBudgets(
  scenario: string,
  phases: Record<string, PhaseReport>,
  budgets: Record<string, Budget> | undefined,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (!budgets) return violations;
  for (const phase of Object.keys(budgets).sort(cmp)) {
    const b = budgets[phase] as Budget;
    const p = phases[phase];
    if (!p) continue;
    const check = (
      metric: string,
      limit: number | undefined,
      actual: number,
      component?: string,
    ) => {
      if (limit !== undefined && actual > limit) {
        violations.push({
          scenario,
          phase,
          metric,
          limit,
          actual,
          ...(component && { component }),
        });
      }
    };
    check('commits', b.maxCommits, p.commits.median);
    check('totalRenders', b.maxTotalRenders, p.totalRenders.median);
    check('wastedRenders', b.maxWastedRenders, p.totalWastedRenders.median);
    check('avoidableRenders', b.maxAvoidableRenders, p.totalAvoidableRenders.median);
    for (const name of Object.keys(b.components ?? {}).sort(cmp)) {
      const cb = b.components?.[name];
      const c = p.components[name];
      if (!cb || !c) continue;
      check('renders', cb.maxRenders, c.renders.median, name);
      check('wastedRenders', cb.maxWastedRenders, c.wastedRenders.median, name);
      check('avoidableRenders', cb.maxAvoidableRenders, c.avoidableRenders.median, name);
    }
  }
  return violations;
}

/** Component budgets that never matched a rendered component are probably typos. */
function budgetWarnings(scenario: Scenario, phases: Record<string, PhaseReport>): string[] {
  const seen = new Set(Object.values(phases).flatMap((p) => Object.keys(p.components)));
  const out: string[] = [];
  for (const [phase, b] of Object.entries(scenario.budgets ?? {})) {
    for (const name of Object.keys(b.components ?? {})) {
      if (!seen.has(name)) {
        out.push(
          `budget for component "${name}" (phase "${phase}") never matched a rendered component; check the name.`,
        );
      }
    }
  }
  return out;
}

/**
 * Gives same-named components stable, source-based keys: when several distinct
 * components share a display name and their definition files differ, they are
 * keyed as `Name (file)` instead of the render-order based `Name`, `Name#2`.
 * Unique names keep their plain key. Also returns key -> definition file.
 */
const LIBRARY_PATH = LIBRARY_FILE;
const locationFile = (loc: string) => loc.replace(/ \(.*\)$/, '').replace(/:\d+$/, '');

/**
 * Removes framework/library internals: components defined in library code that
 * are only ever rendered by library code. Library components that the app
 * renders directly stay (their props may be what needs fixing).
 */
export function hideInternals(runs: RawRun[]): { runs: RawRun[]; hidden: number } {
  const files: Record<string, string> = {};
  for (const r of runs) {
    for (const [k, f] of Object.entries(r.definitions ?? {})) files[k] ??= f;
  }
  const isLibrary = (k: string) => {
    const f = files[k];
    return f !== undefined && LIBRARY_PATH.test(f);
  };
  const internal = new Set<string>();
  for (const r of runs) {
    for (const p of Object.values(r.phases)) {
      for (const [k, c] of Object.entries(p.components)) {
        if (!isLibrary(k)) continue;
        const sites = Object.keys(c.locations ?? {});
        if (sites.every((loc) => LIBRARY_PATH.test(locationFile(loc)))) internal.add(k);
      }
    }
  }
  // Roots that only render library code (e.g. Next's dev overlay, its own React
  // root): everything in them is internal, even components whose definition
  // could not be resolved (rendered while the page was navigating away).
  for (const r of runs) {
    const keysByRoot: Record<string, Set<string>> = {};
    const rootsByKey: Record<string, string[]> = {};
    for (const p of Object.values(r.phases)) {
      for (const [k, c] of Object.entries(p.components)) {
        for (const root of Object.keys(c.roots ?? {})) {
          keysByRoot[root] ??= new Set();
          keysByRoot[root].add(k);
          rootsByKey[k] ??= [];
          if (!rootsByKey[k].includes(root)) rootsByKey[k].push(root);
        }
      }
    }
    const libraryRoots = new Set(
      Object.entries(keysByRoot)
        .filter(([, keys]) => {
          const known = [...keys].filter((k) => files[k] !== undefined);
          return known.length > 0 && known.every(isLibrary);
        })
        .map(([root]) => root),
    );
    for (const [k, roots] of Object.entries(rootsByKey)) {
      if (roots.every((root) => libraryRoots.has(root))) internal.add(k);
    }
  }
  // A component rendered by app code in any phase/run is not internal.
  for (const r of runs) {
    for (const p of Object.values(r.phases)) {
      for (const [k, c] of Object.entries(p.components)) {
        if (!internal.has(k)) continue;
        const sites = Object.keys(c.locations ?? {});
        if (sites.some((loc) => !LIBRARY_PATH.test(locationFile(loc)))) internal.delete(k);
      }
    }
  }
  // Count only commits that rendered at least one visible component: commits
  // that only touched framework internals vary between runs.
  const visibleCommits = (p: RawRun['phases'][string]) =>
    p.commitKeys
      ? Object.entries(p.commitKeys)
          .filter(([sig]) => sig.split('\n').some((k) => !internal.has(k)))
          .reduce((n, [, count]) => n + count, 0)
      : p.commits;
  const filtered = runs.map((r) => ({
    ...r,
    phases: Object.fromEntries(
      Object.entries(r.phases).map(([phase, p]) => [
        phase,
        {
          ...p,
          commits: visibleCommits(p),
          components: Object.fromEntries(
            Object.entries(p.components).filter(([k]) => !internal.has(k)),
          ),
        },
      ]),
    ),
  }));
  return { runs: filtered, hidden: internal.size };
}

/**
 * Keys components that share a name by their definition file (`Item (src/a.tsx)`)
 * so they never mix up. Each run is renamed with its own definitions: `Item#2`
 * may be a different component in each run when modules load in another order.
 */
export function stabilizeKeys(runs: RawRun[]): {
  runs: RawRun[];
  definedIn: Record<string, string>;
} {
  const base = (k: string) => k.replace(/#\d+$/, '');
  const keysOf = (r: RawRun) => {
    const keys = new Set<string>();
    for (const p of Object.values(r.phases)) for (const k of Object.keys(p.components)) keys.add(k);
    return [...keys];
  };
  // Per name: every key and file seen in any run, and whether files tell them apart.
  const groups: Record<string, { keys: Set<string>; files: Set<string>; resolvable: boolean }> = {};
  for (const r of runs) {
    const perRun: Record<string, string[]> = {};
    for (const k of keysOf(r)) {
      const name = base(k);
      groups[name] ??= { keys: new Set(), files: new Set(), resolvable: true };
      const g = groups[name];
      g.keys.add(k);
      const f = r.definitions?.[k];
      if (f) g.files.add(f);
      else g.resolvable = false;
      perRun[name] ??= [];
      perRun[name].push(f ?? '');
    }
    // Two keys with the same file in one run cannot be told apart by file.
    for (const [name, fs] of Object.entries(perRun)) {
      if (new Set(fs).size !== fs.length)
        (groups[name] as { resolvable: boolean }).resolvable = false;
    }
  }
  const byFile = (name: string) => {
    const g = groups[name];
    return !!g && g.resolvable && (g.keys.size > 1 || g.files.size > 1);
  };

  // When files cannot tell them apart (styled-components, HOC factories, several
  // components in one file), fall back to where each one is rendered: the JSX
  // site does not depend on render order the way `Item#2` does.
  const siteOf = (r: RawRun, k: string): string | undefined => {
    const counts: Record<string, number> = {};
    for (const p of Object.values(r.phases)) {
      for (const [loc, n] of Object.entries(p.components[k]?.locations ?? {})) {
        const site = loc.replace(/ \(.*\)$/, '');
        counts[site] = (counts[site] ?? 0) + n;
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1] || cmpNatural(a[0], b[0]))[0]?.[0];
  };
  // Components made by a library factory (styled.div, withRouter(Page)) are
  // always keyed by site: adding a second one must not rename the first.
  const isFactory = (name: string, g: { files: Set<string> }) =>
    (/^styled\./.test(name) || /\(.+\)$/.test(name)) &&
    g.files.size > 0 &&
    [...g.files].every((f) => LIBRARY_PATH.test(f));
  const bySite = new Set<string>();
  for (const [name, g] of Object.entries(groups)) {
    if ((g.keys.size < 2 && !isFactory(name, g)) || byFile(name)) continue;
    const ok = runs.every((r) => {
      const sites = keysOf(r)
        .filter((k) => base(k) === name)
        .map((k) => siteOf(r, k));
      return sites.every(Boolean) && new Set(sites).size === sites.length;
    });
    if (ok) bySite.add(name);
  }

  const definedIn: Record<string, string> = {};
  const renamed = runs.map((r) => {
    const rename: Record<string, string> = {};
    for (const k of keysOf(r)) {
      const f = r.definitions?.[k];
      const site = bySite.has(base(k)) ? siteOf(r, k) : undefined;
      const key = byFile(base(k)) && f ? `${base(k)} (${f})` : site ? `${base(k)} @ ${site}` : k;
      if (key !== k) rename[k] = key;
      if (f) definedIn[key] ??= f;
    }
    if (Object.keys(rename).length === 0) return r;
    const remap = (m: Record<string, number> | undefined) =>
      Object.fromEntries(Object.entries(m ?? {}).map(([t, n]) => [rename[t] ?? t, n]));
    return {
      ...r,
      phases: Object.fromEntries(
        Object.entries(r.phases).map(([phase, p]) => [
          phase,
          {
            ...p,
            ...(p.memoSkips && { memoSkips: remap(p.memoSkips) }),
            components: Object.fromEntries(
              Object.entries(p.components).map(([k, v]) => [
                rename[k] ?? k,
                { ...v, triggeredBy: remap(v.triggeredBy) },
              ]),
            ),
          },
        ]),
      ),
    };
  });
  return { runs: renamed, definedIn };
}

export function buildReport(
  results: { scenario: Scenario; runs: RawRun[] }[],
  config: CrispyConfig,
): CrispyReport {
  const scenarios: Record<string, ScenarioReport> = {};
  let reactVersion: string | null = null;
  let profilingBuild = false;

  const skips: Record<string, number> = {};
  const updates: Record<string, number> = {};
  for (const { scenario, runs: rawRuns } of results) {
    const visible = config.includeInternals ? { runs: rawRuns, hidden: 0 } : hideInternals(rawRuns);
    const { runs, definedIn } = stabilizeKeys(visible.runs);
    reactVersion ??= runs[0]?.reactVersion ?? null;
    profilingBuild ||= runs.some((r) => r.profilingBuild);

    const phaseNames = new Set<string>();
    for (const r of runs) for (const p of Object.keys(r.phases)) phaseNames.add(p);
    // Phases in the order the scenario declares them ("load" first).
    const declared = phasesOf(scenario);
    const rank = (p: string) => (declared.includes(p) ? declared.indexOf(p) : declared.length);
    const order = [...phaseNames].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
    const phases: Record<string, PhaseReport> = {};
    // Definition files of every component seen, internals included.
    const allFiles: Record<string, string> = { ...definedIn };
    for (const r of rawRuns)
      for (const [k, f] of Object.entries(r.definitions ?? {})) allFiles[k] ??= f;
    for (const p of order) {
      const phase = aggregatePhase(runs, p, config);
      phases[p] = phase;
      for (const [k, c] of Object.entries(phase.components)) {
        if (definedIn[k]) c.definedIn = definedIn[k];
      }
      const referenced = new Set<string>();
      for (const c of Object.values(phase.components)) {
        for (const key of Object.keys(c.creators)) referenced.add(key.split('|')[1] as string);
        for (const k of Object.keys(c.recreatedContextFrom)) referenced.add(k);
        for (const k of Object.keys(c.triggeredBy)) referenced.add(k);
      }
      const library = [...referenced]
        .filter((k) => allFiles[k] && LIBRARY_PATH.test(allFiles[k]))
        .sort(cmp);
      if (library.length) phase.library = library;
    }

    // React.memo verdicts look at every phase of every scenario: a memo that
    // skips nothing in one flow may skip every render in another.
    for (const p of order) {
      const keys = new Set(runs.flatMap((r) => Object.keys(r.phases[p]?.memoSkips ?? {})));
      for (const k of keys) {
        skips[k] = (skips[k] ?? 0) + stat(runs.map((r) => r.phases[p]?.memoSkips?.[k] ?? 0)).median;
      }
      for (const [k, c] of Object.entries((phases[p] as PhaseReport).components)) {
        updates[k] = (updates[k] ?? 0) + c.updates.median;
      }
    }

    const report: ScenarioReport = {
      name: scenario.name,
      path: scenario.path,
      runs: runs.length,
      phases,
      // Budgets are checked on the full component list, before `topComponents` trims it.
      violations: checkBudgets(scenario.name, phases, scenario.budgets),
      // Varies with dev-server state (cold compiles render extra internals).
      ...(config.timings && visible.hidden > 0 && { hiddenInternals: visible.hidden }),
      warnings: [
        ...new Set([...runs.flatMap((r) => r.warnings ?? []), ...budgetWarnings(scenario, phases)]),
      ].sort(cmp),
    };
    if (config.topComponents > 0) {
      for (const p of Object.values(phases)) {
        p.components = Object.fromEntries(
          Object.entries(p.components).slice(0, config.topComponents),
        );
      }
    }
    if (config.timings) {
      const lcp = runs.map((r) => r.vitals.lcpMs).filter((v): v is number => v !== null);
      report.vitals = {
        lcpMs: lcp.length ? stat(lcp) : null,
        cls: stat(runs.map((r) => r.vitals.cls)),
        longTasks: stat(runs.map((r) => r.vitals.longTasks)),
        totalBlockingMs: stat(runs.map((r) => r.vitals.totalBlockingMs)),
      };
    }
    scenarios[scenario.name] = report;
  }

  for (const s of Object.values(scenarios)) {
    for (const p of Object.values(s.phases)) {
      for (const [k, c] of Object.entries(p.components)) {
        c.memoSkips = skips[k] ?? 0;
        if (c.memo && !skips[k] && (updates[k] ?? 0) >= 3) c.uselessMemo = true;
      }
    }
  }

  return {
    schemaVersion: 1,
    tool: { name: 'crispy-profiling', version: VERSION },
    reactVersion,
    profilingBuild,
    scenarios,
    violations: Object.values(scenarios).flatMap((s) => s.violations),
  };
}

/** Serializes a report. Output is byte-for-byte reproducible for identical inputs. */
export function serializeReport(report: CrispyReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

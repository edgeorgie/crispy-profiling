import type { Budget, CrispyConfig, Scenario } from '../config.js';
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
import { cmp } from '../util/cmp.js';
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
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
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
    memo: samples.some((s) => s?.memo),
    locations: Object.keys(medianCounts(samples, (s) => s.locations)).slice(0, 3),
    stable: renders.min === renders.max,
  };
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
const LIBRARY_PATH = /(^|\/)node_modules(\/|_)|\.vite\/deps\/|(^|\/)next\/dist\//;
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
  const internal = new Set<string>();
  const seen = new Set<string>();
  for (const r of runs) {
    for (const p of Object.values(r.phases)) {
      for (const [k, c] of Object.entries(p.components)) {
        seen.add(k);
        const file = files[k];
        if (!file || !LIBRARY_PATH.test(file)) continue;
        const sites = Object.keys(c.locations ?? {});
        if (sites.every((loc) => LIBRARY_PATH.test(locationFile(loc)))) internal.add(k);
      }
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
  if (internal.size === 0) return { runs, hidden: 0 };
  const filtered = runs.map((r) => ({
    ...r,
    phases: Object.fromEntries(
      Object.entries(r.phases).map(([phase, p]) => [
        phase,
        {
          ...p,
          components: Object.fromEntries(
            Object.entries(p.components).filter(([k]) => !internal.has(k)),
          ),
        },
      ]),
    ),
  }));
  return { runs: filtered, hidden: internal.size };
}

export function stabilizeKeys(runs: RawRun[]): {
  runs: RawRun[];
  definedIn: Record<string, string>;
} {
  const files: Record<string, string> = {};
  for (const r of runs) {
    for (const [k, f] of Object.entries(r.definitions ?? {})) files[k] ??= f;
  }
  const base = (k: string) => k.replace(/#\d+$/, '');
  const groups: Record<string, string[]> = {};
  for (const r of runs) {
    for (const p of Object.values(r.phases)) {
      for (const k of Object.keys(p.components)) {
        const name = base(k);
        if (!groups[name]) groups[name] = [];
        if (!groups[name].includes(k)) groups[name].push(k);
      }
    }
  }
  const rename: Record<string, string> = {};
  for (const [name, keys] of Object.entries(groups)) {
    if (keys.length < 2) continue;
    const fs = keys.map((k) => files[k]);
    if (fs.some((f) => !f) || new Set(fs).size !== fs.length) continue;
    keys.forEach((k, i) => {
      rename[k] = `${name} (${fs[i]})`;
    });
  }
  const definedIn: Record<string, string> = {};
  for (const [k, f] of Object.entries(files)) definedIn[rename[k] ?? k] = f;
  if (Object.keys(rename).length === 0) return { runs, definedIn };
  const renamed = runs.map((r) => ({
    ...r,
    phases: Object.fromEntries(
      Object.entries(r.phases).map(([phase, p]) => [
        phase,
        {
          ...p,
          components: Object.fromEntries(
            Object.entries(p.components).map(([k, v]) => [
              rename[k] ?? k,
              {
                ...v,
                triggeredBy: Object.fromEntries(
                  Object.entries(v.triggeredBy ?? {}).map(([t, n]) => [rename[t] ?? t, n]),
                ),
              },
            ]),
          ),
        },
      ]),
    ),
  }));
  return { runs: renamed, definedIn };
}

export function buildReport(
  results: { scenario: Scenario; runs: RawRun[] }[],
  config: CrispyConfig,
): CrispyReport {
  const scenarios: Record<string, ScenarioReport> = {};
  let reactVersion: string | null = null;
  let profilingBuild = false;

  for (const { scenario, runs: rawRuns } of results) {
    const visible = config.includeInternals ? { runs: rawRuns, hidden: 0 } : hideInternals(rawRuns);
    const { runs, definedIn } = stabilizeKeys(visible.runs);
    reactVersion ??= runs[0]?.reactVersion ?? null;
    profilingBuild ||= runs.some((r) => r.profilingBuild);

    const phaseNames = new Set<string>();
    for (const r of runs) for (const p of Object.keys(r.phases)) phaseNames.add(p);
    // "load" first, then the remaining phases alphabetically.
    const order = [...phaseNames].sort((a, b) =>
      a === 'load' ? -1 : b === 'load' ? 1 : cmp(a, b),
    );
    const phases: Record<string, PhaseReport> = {};
    for (const p of order) {
      phases[p] = aggregatePhase(runs, p, config);
      for (const [k, c] of Object.entries((phases[p] as PhaseReport).components)) {
        if (definedIn[k]) c.definedIn = definedIn[k];
      }
    }

    const report: ScenarioReport = {
      name: scenario.name,
      path: scenario.path,
      runs: runs.length,
      phases,
      // Budgets are checked on the full component list, before `topComponents` trims it.
      violations: checkBudgets(scenario.name, phases, scenario.budgets),
      ...(visible.hidden > 0 && { hiddenInternals: visible.hidden }),
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

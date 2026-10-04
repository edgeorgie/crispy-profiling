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

function byRendersThenName(a: [string, ComponentReport], b: [string, ComponentReport]): number {
  return b[1].renders.median - a[1].renders.median || cmp(a[0], b[0]);
}

function aggregateComponent(
  samples: (RawComponentStats | undefined)[],
  timings: boolean,
): ComponentReport {
  const pick = (f: (s: RawComponentStats) => number) => samples.map((s) => (s ? f(s) : 0));
  const renders = stat(pick((s) => s.renders));

  const propKeys = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s?.changedProps ?? {})) propKeys.add(k);
  const changedProps = [...propKeys]
    .map((k) => [k, medianOf(samples.map((s) => s?.changedProps[k] ?? 0))] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));

  const report: ComponentReport = {
    renders,
    mounts: stat(pick((s) => s.mounts)),
    updates: stat(pick((s) => s.updates)),
    wastedRenders: stat(pick((s) => s.wastedRenders)),
    causes: {
      props: medianOf(pick((s) => s.causes.props)),
      state: medianOf(pick((s) => s.causes.state)),
      context: medianOf(pick((s) => s.causes.context)),
      parent: medianOf(pick((s) => s.causes.parent)),
    },
    changedProps: Object.fromEntries(changedProps),
    stable: renders.min === renders.max,
  };
  if (timings) report.selfDurationMs = stat(pick((s) => s.selfDurationMs));
  return report;
}

function aggregatePhase(runs: RawRun[], phase: string, config: CrispyConfig): PhaseReport {
  const names = new Set<string>();
  for (const r of runs)
    for (const n of Object.keys(r.phases[phase]?.components ?? {})) names.add(n);

  let entries = [...names]
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
    .sort(byRendersThenName);

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
    components: {},
  };
  if (config.topComponents > 0) entries = entries.slice(0, config.topComponents);
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
    for (const name of Object.keys(b.components ?? {}).sort(cmp)) {
      const cb = b.components?.[name];
      const c = p.components[name];
      if (!cb || !c) continue;
      check('renders', cb.maxRenders, c.renders.median, name);
      check('wastedRenders', cb.maxWastedRenders, c.wastedRenders.median, name);
    }
  }
  return violations;
}

export function buildReport(
  results: { scenario: Scenario; runs: RawRun[] }[],
  config: CrispyConfig,
): CrispyReport {
  const scenarios: Record<string, ScenarioReport> = {};
  let reactVersion: string | null = null;
  let profilingBuild = false;

  for (const { scenario, runs } of results) {
    reactVersion ??= runs[0]?.reactVersion ?? null;
    profilingBuild ||= runs.some((r) => r.profilingBuild);

    const phaseNames = new Set<string>();
    for (const r of runs) for (const p of Object.keys(r.phases)) phaseNames.add(p);
    // "load" first, then the remaining phases alphabetically.
    const order = [...phaseNames].sort((a, b) =>
      a === 'load' ? -1 : b === 'load' ? 1 : cmp(a, b),
    );
    const phases: Record<string, PhaseReport> = {};
    for (const p of order) phases[p] = aggregatePhase(runs, p, config);

    const report: ScenarioReport = {
      name: scenario.name,
      path: scenario.path,
      runs: runs.length,
      phases,
      violations: checkBudgets(scenario.name, phases, scenario.budgets),
      warnings: [...new Set(runs.flatMap((r) => r.warnings ?? []))].sort(cmp),
    };
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

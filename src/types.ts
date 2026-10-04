/** Raw data collected in the browser for a single phase of a single run. */
export interface RawComponentStats {
  renders: number;
  mounts: number;
  updates: number;
  /** Updates where props (shallow), state and consumed context were all unchanged. */
  wastedRenders: number;
  /** Prop keys whose identity changed between renders, with how often. */
  changedProps: Record<string, number>;
  /** Number of updates attributed to each cause. A render can have several causes. */
  causes: { props: number; state: number; context: number; parent: number };
  /** Sum of selfBaseDuration in ms (only available in development/profiling builds). */
  selfDurationMs: number;
}

export interface RawPhase {
  commits: number;
  components: Record<string, RawComponentStats>;
}

export interface RawRun {
  reactVersion: string | null;
  profilingBuild: boolean;
  phases: Record<string, RawPhase>;
  vitals: { lcpMs: number | null; cls: number; longTasks: number; totalBlockingMs: number };
  /** Problems that make the numbers less trustworthy (e.g. the page never settled). */
  warnings: string[];
}

/** Aggregated (multi-run) statistic. Counts are deterministic, so min === max in a stable app. */
export interface Stat {
  median: number;
  min: number;
  max: number;
}

export interface ComponentReport {
  renders: Stat;
  mounts: Stat;
  updates: Stat;
  wastedRenders: Stat;
  /** Only present when `timings: true` (timings are not deterministic). */
  selfDurationMs?: Stat;
  causes: { props: number; state: number; context: number; parent: number };
  /** Top changed prop keys (median across runs), sorted by count desc then name. */
  changedProps: Record<string, number>;
  stable: boolean;
}

export interface PhaseReport {
  commits: Stat;
  totalRenders: Stat;
  totalWastedRenders: Stat;
  components: Record<string, ComponentReport>;
}

export interface BudgetViolation {
  scenario: string;
  phase: string;
  metric: string;
  component?: string;
  limit: number;
  actual: number;
}

export interface ScenarioReport {
  name: string;
  /** Path relative to baseUrl, so reports are portable across hosts/ports. */
  path: string;
  runs: number;
  phases: Record<string, PhaseReport>;
  /** Only present when `timings: true` (timings are not deterministic). */
  vitals?: { lcpMs: Stat | null; cls: Stat; longTasks: Stat; totalBlockingMs: Stat };
  violations: BudgetViolation[];
  /** Deduplicated warnings from all runs (e.g. "never settled"). */
  warnings: string[];
}

export interface CrispyReport {
  schemaVersion: 1;
  tool: { name: 'crispy-profiling'; version: string };
  reactVersion: string | null;
  profilingBuild: boolean;
  scenarios: Record<string, ScenarioReport>;
  violations: BudgetViolation[];
}

export interface ComponentDiff {
  scenario: string;
  phase: string;
  component: string;
  baseRenders: number;
  headRenders: number;
  delta: number;
  deltaPct: number | null;
  baseWasted: number;
  headWasted: number;
  status: 'regressed' | 'improved' | 'unchanged' | 'added';
}

export interface CompareResult {
  regressions: ComponentDiff[];
  improvements: ComponentDiff[];
  diffs: ComponentDiff[];
  totals: { baseRenders: number; headRenders: number; baseWasted: number; headWasted: number };
  passed: boolean;
}

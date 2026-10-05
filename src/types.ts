/**
 * Why updates happened. `props`/`state`/`context` = that input really changed;
 * `unstable` = only data identities changed (equal contents); `callback` = only
 * functions were recreated with the same code (avoidable unless the values they
 * capture changed); `parent` = nothing changed.
 */
export interface Causes {
  props: number;
  state: number;
  context: number;
  unstable: number;
  callback: number;
  parent: number;
}

/** Raw data collected in the browser for a single phase of a single run. */
export interface RawComponentStats {
  renders: number;
  mounts: number;
  updates: number;
  /** Updates where props (shallow), state and consumed context were all unchanged. */
  wastedRenders: number;
  /**
   * Updates where nothing really changed: wasted renders plus renders caused only by
   * recreated-but-equal inputs (inline callbacks, object/array literals, context values).
   */
  avoidableRenders: number;
  /** Prop keys whose identity changed between renders, with how often. */
  changedProps: Record<string, number>;
  /** Prop keys recreated with equal data (objects, arrays, elements, dates…), with how often. */
  unstableProps: Record<string, number>;
  /** Prop keys that were new functions with the same code, with how often. */
  callbackProps: Record<string, number>;
  /** Updates caused only by recreated callbacks (avoidable if their captured values didn't change). */
  callbackRenders: number;
  /** Ancestor whose own state change started the cascade that re-rendered this component. */
  triggeredBy: Record<string, number>;
  /** Components whose context value was recreated with equal content (provider owners). */
  recreatedContextFrom: Record<string, number>;
  /** Which state changed when the component's own state caused the render, e.g. "`query` (useState)". */
  stateChanges?: Record<string, number>;
  /** Where those providers are rendered ("file:line (Owner)"), with counts. */
  providerAt?: Record<string, number>;
  /** "prop|Creator": the component that created a recreated prop value (forwarders skipped). */
  creators?: Record<string, number>;
  /** "prop|Creator|#2 (an object)": the prop comes from useCallback/useMemo whose deps changed. */
  staleMemo?: Record<string, number>;
  /**
   * State set by this component's useEffect right after the previous commit (an
   * extra commit), by state: "`d` (useState)", "`total` (useState) in `Parent`"
   * (a setter passed as a prop) or "a store read by `Reader`".
   */
  effectCascades?: Record<string, number>;
  /** Extra commits those effects caused, and the renders in them. */
  cascadeCommits?: number;
  cascadeRenders?: number;
  /** Renders of this component inside extra commits caused by effects (anyone's). */
  inEffectCascades?: number;
  /** Compiled by React Compiler. */
  compiled?: boolean;
  /** Wrapped in React.memo. */
  memo: boolean;
  /** Number of updates attributed to each cause. A render can have several causes. */
  causes: Causes;
  /** Where the component is rendered ("file:line (Owner)") with how often. */
  locations: Record<string, number>;
  /** Sum of selfBaseDuration in ms (only available in development/profiling builds). */
  selfDurationMs: number;
  /** React roots ("document.order") the component rendered in. */
  roots?: Record<string, 1>;
}

export interface RawPhase {
  commits: number;
  components: Record<string, RawComponentStats>;
  /** Component keys rendered by each commit ("\n"-joined, sorted) -> number of commits. */
  commitKeys?: Record<string, number>;
  /** Component key -> times React.memo skipped its render while its parent rendered. */
  memoSkips?: Record<string, number>;
}

export interface RawRun {
  reactVersion: string | null;
  profilingBuild: boolean;
  phases: Record<string, RawPhase>;
  vitals: { lcpMs: number | null; cls: number; longTasks: number; totalBlockingMs: number };
  /** Problems that make the numbers less trustworthy (e.g. the page never settled). */
  warnings: string[];
  /** Component key -> file where the component function is defined (when resolvable). */
  definitions?: Record<string, string>;
  /** Main-thread CPU per phase in ms (CDP ScriptDuration / TaskDuration), only with `timings`. */
  cost?: Record<string, { scriptMs: number; taskMs: number }>;
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
  avoidableRenders: Stat;
  /** Only present when `timings: true` (timings are not deterministic). */
  selfDurationMs?: Stat;
  causes: Causes;
  /** Top changed prop keys (median across runs), sorted by count desc then name. */
  changedProps: Record<string, number>;
  /** Prop keys recreated with equal data (fix with useMemo / hoisting). */
  unstableProps: Record<string, number>;
  /** Prop keys that were recreated callbacks (fix with useCallback and correct deps). */
  callbackProps: Record<string, number>;
  /** Updates caused only by recreated callbacks. */
  callbackRenders: Stat;
  /** Root cause of cascades: ancestor whose own state change re-rendered this component. */
  triggeredBy: Record<string, number>;
  /** Provider owners whose context value was recreated with equal content. */
  recreatedContextFrom: Record<string, number>;
  /** Which state changed when the component's own state caused the render, e.g. "`query` (useState)". */
  stateChanges: Record<string, number>;
  /** Where those providers are rendered ("file:line (Owner)"), most frequent first. */
  providerAt: string[];
  /** "prop|Creator": the component that created a recreated prop value (forwarders skipped). */
  creators: Record<string, number>;
  /** "prop|Creator|#2 (an object)": the prop comes from useCallback/useMemo whose dependencies changed. */
  staleMemo: Record<string, number>;
  /**
   * State set by a useEffect right after the previous commit, by state name, e.g.
   * {"`doubled` (useState)": 2}: each one costs an extra commit (derive the value
   * during render instead). Omitted when empty.
   */
  effectCascades?: Record<string, number>;
  /** Extra commits those effects caused, and the renders in them (medians). */
  cascadeCommits?: number;
  cascadeRenders?: number;
  /** Renders of this component inside extra commits caused by effects (median). */
  inEffectCascades?: number;
  /** Compiled by React Compiler. */
  compiled: boolean;
  /** Wrapped in React.memo. */
  memo: boolean;
  /** Renders React.memo skipped across all phases and scenarios of this report. */
  memoSkips: number;
  /**
   * Wrapped in React.memo, updated at least 3 times in this report and never
   * skipped a render in any flow: its props change every time, so the memo only adds cost.
   */
  uselessMemo?: true;
  /** Up to 3 places where the component is rendered ("file:line (Owner)"), most frequent first. */
  locations: string[];
  /** File where the component function is defined, when known (part of its identity). */
  definedIn?: string;
  stable: boolean;
}

export interface PhaseReport {
  commits: Stat;
  totalRenders: Stat;
  totalWastedRenders: Stat;
  totalAvoidableRenders: Stat;
  totalCallbackRenders: Stat;
  /**
   * Main-thread CPU spent in the phase, in ms: JavaScript (`scriptMs`) and all
   * tasks (`taskMs`, including layout and style). Works in production builds.
   * Only with `timings: true` (not reproducible byte for byte).
   */
  cost?: { scriptMs: Stat; taskMs: Stat };
  components: Record<string, ComponentReport>;
  /**
   * Components referenced by this phase (as creators, providers, triggers or owners)
   * that are library code, including internals hidden from `components`. Used so
   * hints never point into libraries.
   */
  library?: string[];
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
  /**
   * Number of framework/library internals hidden from the report (see `includeInternals`).
   * Only with `timings: true`: it depends on dev-server state, so it is not reproducible.
   */
  hiddenInternals?: number;
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
  baseAvoidable: number;
  headAvoidable: number;
  status: 'regressed' | 'improved' | 'unchanged' | 'added';
}

export interface CompareResult {
  regressions: ComponentDiff[];
  improvements: ComponentDiff[];
  diffs: ComponentDiff[];
  totals: {
    baseRenders: number;
    headRenders: number;
    baseWasted: number;
    headWasted: number;
    baseAvoidable: number;
    headAvoidable: number;
  };
  passed: boolean;
}

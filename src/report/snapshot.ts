import type { ComponentReport, CrispyReport, Stat } from '../types.js';
import { cmp } from '../util/cmp.js';
import { LIBRARY_FILE } from '../util/paths.js';
import { hintFor } from './hints.js';
import { GREEN_CAVEAT } from './markdown.js';

/**
 * Render snapshot: the expected render counts of every scenario, committed to the
 * repository so render changes show up in code review and fail CI when they grow.
 * Ordering is alphabetical (not by count) so diffs stay small and readable.
 */
export interface RenderSnapshot {
  schemaVersion: 1;
  scenarios: Record<string, Record<string, PhaseSnapshot>>;
}

/**
 * A count, or a `[min, max]` range when it varied between runs (flaky). Ranges
 * are compared loosely: only values outside the range count as changes.
 */
export type Count = number | [number, number];

export interface PhaseSnapshot {
  commits: Count;
  /** `file` = where the component is defined; used to match it if its key changes. */
  /**
   * `mutable`: the component reads a mutable instance (a table or form API) or data
   * that changes without its props. Fewer renders there may mean a frozen UI.
   */
  components: Record<string, { renders: Count; avoidable: Count; file?: string; mutable?: true }>;
}

const lo = (c: Count) => (Array.isArray(c) ? c[0] : c);
const hi = (c: Count) => (Array.isArray(c) ? c[1] : c);
const toCount = (s: Stat): Count => (s.min === s.max ? s.median : [s.min, s.max]);
const fmt = (c: Count | null) =>
  c === null ? '—' : Array.isArray(c) ? `${c[0]}..${c[1]}` : `${c}`;

export type SnapshotStatus = 'regressed' | 'improved' | 'new' | 'removed' | 'renamed';

export interface SnapshotChange {
  scenario: string;
  phase: string;
  /** Undefined for phase-level changes (commit counts). */
  component?: string;
  metric: 'renders' | 'avoidable' | 'commits';
  expected: Count | null;
  actual: Count | null;
  /** The snapshot or the current run varied between runs; treat with care. */
  flaky?: boolean;
  status: SnapshotStatus;
  /** Short explanation and suggested fix for regressions, from the current report. */
  hint?: string;
  /** For `renamed`: the component's key in the snapshot. */
  renamedFrom?: string;
  /** New component that already renders avoidably (reported, not failing). */
  warning?: true;
  /**
   * More avoidable renders, but not more renders: the same renders now have a
   * clear, fixable cause (often uncovered by a previous fix). Reported, not failing.
   */
  uncovered?: true;
  /** Fewer renders on a `mutable` component: check that the UI still updates. */
  suspect?: true;
  /**
   * The component whose state updates re-rendered this regressed one: the highest
   * regressed ancestor in the cascade, else its direct trigger. Fix the root first.
   */
  rootCause?: string;
}

export interface SnapshotResult {
  passed: boolean;
  changes: SnapshotChange[];
  regressions: SnapshotChange[];
  improvements: SnapshotChange[];
  /** Scenarios, phases or components that have no snapshot yet. */
  additions: SnapshotChange[];
}

/** Sorts phase names by their position in `order` (the report's, i.e. declaration order). */
const inOrder = (names: Iterable<string>, order: string[]) => {
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || cmp(a, b));
};

/** Renders that could be avoided: unchanged inputs plus recreated callbacks. */
function fixableStat(c: ComponentReport): Stat {
  return {
    median: c.avoidableRenders.median + c.callbackRenders.median,
    min: c.avoidableRenders.min + c.callbackRenders.min,
    max: c.avoidableRenders.max + c.callbackRenders.max,
  };
}

export function toSnapshot(report: CrispyReport): RenderSnapshot {
  const scenarios: RenderSnapshot['scenarios'] = {};
  for (const name of Object.keys(report.scenarios).sort(cmp)) {
    const s = report.scenarios[name];
    if (!s) continue;
    const phases: Record<string, PhaseSnapshot> = {};
    for (const phase of Object.keys(s.phases)) {
      const p = s.phases[phase];
      if (!p) continue;
      const components: PhaseSnapshot['components'] = {};
      for (const c of Object.keys(p.components).sort(cmp)) {
        const r = p.components[c] as ComponentReport;
        components[c] = {
          renders: toCount(r.renders),
          // Avoidable = unchanged inputs + recreated callbacks (as in the report header).
          avoidable: toCount(fixableStat(r)),
          ...(r.definedIn && { file: r.definedIn }),
          ...((Object.keys(r.instanceProps ?? {}).length > 0 || (r.mutableReads ?? 0) > 0) && {
            mutable: true as const,
          }),
        };
      }
      phases[phase] = { commits: toCount(p.commits), components };
    }
    scenarios[name] = phases;
  }
  return { schemaVersion: 1, scenarios };
}

/**
 * Pretty JSON with one line per component, so a PR diff shows exactly which
 * component's counts changed.
 */
export function serializeSnapshot(snapshot: RenderSnapshot): string {
  const q = JSON.stringify;
  const out: string[] = ['{', '  "schemaVersion": 1,', '  "scenarios": {'];
  const scenarios = Object.entries(snapshot.scenarios);
  scenarios.forEach(([name, phases], si) => {
    out.push(`    ${q(name)}: {`);
    const entries = Object.entries(phases);
    entries.forEach(([phase, p], pi) => {
      out.push(`      ${q(phase)}: {`);
      out.push(`        "commits": ${q(p.commits)},`);
      const comps = Object.entries(p.components);
      if (comps.length === 0) out.push('        "components": {}');
      else {
        out.push('        "components": {');
        comps.forEach(([c, v], ci) => {
          const comma = ci < comps.length - 1 ? ',' : '';
          const file = v.file ? `, "file": ${q(v.file)}` : '';
          const mutable = v.mutable ? ', "mutable": true' : '';
          out.push(
            `          ${q(c)}: { "renders": ${q(v.renders)}, "avoidable": ${q(v.avoidable)}${file}${mutable} }${comma}`,
          );
        });
        out.push('        }');
      }
      out.push(`      }${pi < entries.length - 1 ? ',' : ''}`);
    });
    out.push(`    }${si < scenarios.length - 1 ? ',' : ''}`);
  });
  out.push('  }', '}');
  return `${out.join('\n')}\n`;
}

export function parseSnapshot(text: string): RenderSnapshot {
  const json = JSON.parse(text);
  if (json?.schemaVersion !== 1 || typeof json.scenarios !== 'object') {
    throw new Error('Not a crispy render snapshot (expected schemaVersion 1)');
  }
  return json as RenderSnapshot;
}

/**
 * Compares the current report with the committed snapshot. Any increase in
 * renders or avoidable renders is a regression; decreases are improvements that
 * can be locked in with `--update`. New components that only mount are additions.
 */
/** Display name without the disambiguation suffix ("Item (src/a.tsx)", "Item#2" -> "Item"). */
const baseName = (k: string) =>
  k
    .replace(/ @ .*$/, '')
    .replace(/ \(.*\)$/, '')
    .replace(/#\d+$/, '');

/**
 * Matches snapshot components to current ones by (name, definition file) when
 * their keys differ — e.g. "Item" became "Item (src/List.tsx)" because another
 * `Item` was added elsewhere. Returns the snapshot phase with keys remapped.
 */
function alignKeys(exp: PhaseSnapshot, current: Record<string, ComponentReport>): PhaseSnapshot {
  const byIdentity = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [k, c] of Object.entries(current)) {
    // Library factories (styled.div…) all share the library's file: not an identity.
    if (!c.definedIn || LIBRARY_FILE.test(c.definedIn)) continue;
    const id = `${baseName(k)}|${c.definedIn}`;
    if (byIdentity.has(id)) ambiguous.add(id);
    byIdentity.set(id, k);
  }
  for (const id of ambiguous) byIdentity.delete(id);
  const components: PhaseSnapshot['components'] = {};
  for (const [k, v] of Object.entries(exp.components)) {
    const match = !current[k] && v.file ? byIdentity.get(`${baseName(k)}|${v.file}`) : undefined;
    const key = match && !exp.components[match] ? match : k;
    components[key] = v;
  }
  return { ...exp, components };
}

const sameCount = (a: Count, b: Count) => lo(a) === lo(b) && hi(a) === hi(b);

/**
 * How to treat a component missing from a snapshot phase:
 * - a component the snapshot knows (other phases) that starts updating, or
 *   renders avoidably, is a regression;
 * - new UI is an addition; if it already renders avoidably it carries a
 *   warning, and fails only with `failOnNewAvoidable`.
 */
function additionStatus(
  c: ComponentReport | undefined,
  knownElsewhere: boolean,
  failOnNewAvoidable = false,
): 'new' | 'warn' | 'regressed' {
  if (!c) return 'new';
  const fixable = c.avoidableRenders.max > 0 || c.callbackRenders.max > 0;
  if (knownElsewhere) return c.updates.max === 0 && !fixable ? 'new' : 'regressed';
  if (!fixable) return 'new';
  return failOnNewAvoidable ? 'regressed' : 'warn';
}

/** Component keys recorded in any phase of a snapshot scenario. */
const knownIn = (phases: Record<string, PhaseSnapshot> | undefined) =>
  new Set(Object.values(phases ?? {}).flatMap((p) => Object.keys(p.components)));

/**
 * Pure renames: a snapshot component missing now and a new component defined in
 * the same file with identical counts. Returns snapshot key -> current key.
 */
function detectRenames(exp: PhaseSnapshot, current: PhaseSnapshot): Map<string, string> {
  const renames = new Map<string, string>();
  const added = Object.keys(current.components).filter((k) => !exp.components[k]);
  const taken = () => [...renames.values()];
  // Same component under a new key (`styled.h3` became `styled.h3 @ src/Card.tsx:28`).
  for (const old of Object.keys(exp.components).sort(cmp)) {
    const e = exp.components[old];
    if (!e || current.components[old]) continue;
    const candidates = added.filter((k) => {
      const c = current.components[k];
      return (
        c !== undefined &&
        baseName(k) === baseName(old) &&
        !taken().includes(k) &&
        sameCount(c.renders, e.renders) &&
        sameCount(c.avoidable, e.avoidable)
      );
    });
    if (candidates.length === 1) renames.set(old, candidates[0] as string);
  }
  for (const old of Object.keys(exp.components).sort(cmp)) {
    if (renames.has(old)) continue;
    const e = exp.components[old];
    // A library file (styled-components…) is shared by many components: not an identity.
    if (!e?.file || LIBRARY_FILE.test(e.file) || current.components[old]) continue;
    const candidates = added.filter((k) => {
      const c = current.components[k];
      return (
        c !== undefined &&
        c.file === e.file &&
        ![...renames.values()].includes(k) &&
        sameCount(c.renders, e.renders) &&
        sameCount(c.avoidable, e.avoidable)
      );
    });
    // Ambiguous (several identical candidates): don't guess.
    if (candidates.length === 1) renames.set(old, candidates[0] as string);
  }
  // Renamed and moved to another file: accept only an unambiguous 1:1 match.
  const removed = Object.keys(exp.components)
    .filter((k) => !current.components[k] && !renames.has(k))
    .sort(cmp);
  const same = (a: string, b: string) => {
    const e = exp.components[a];
    const c = current.components[b];
    return !!e && !!c && sameCount(c.renders, e.renders) && sameCount(c.avoidable, e.avoidable);
  };
  const free = added.filter((k) => ![...renames.values()].includes(k));
  for (const old of removed) {
    const matches = free.filter((k) => same(old, k));
    const rivals = removed.filter((o) => matches[0] !== undefined && same(o, matches[0]));
    if (matches.length === 1 && rivals.length === 1) renames.set(old, matches[0] as string);
  }
  return renames;
}

export function compareSnapshot(
  snapshot: RenderSnapshot,
  report: CrispyReport,
  tolerance = 0,
  /** When only some scenarios ran, don't report the others as removed. */
  partial = false,
  failOnNewAvoidable = false,
  failOnMoreAvoidable = false,
): SnapshotResult {
  const current = toSnapshot(report);
  const changes: SnapshotChange[] = [];

  /**
   * Compares one metric. Regression: even the best current run exceeds the
   * snapshot's upper bound (+ tolerance). Improvement: even the worst current
   * run is below the snapshot's lower bound. Every metric is checked, so an
   * improvement in one never hides a regression in another.
   */
  const check = (
    base: Omit<SnapshotChange, 'metric' | 'expected' | 'actual' | 'status'>,
    metric: SnapshotChange['metric'],
    expected: Count,
    actual: Stat,
    hint?: string,
    slack = tolerance,
    uncovered = false,
  ) => {
    const flaky = Array.isArray(expected) || actual.min !== actual.max;
    const entry = { ...base, metric, expected, actual: toCount(actual), ...(flaky && { flaky }) };
    if (actual.min > hi(expected) + slack) {
      changes.push({
        ...entry,
        status: 'regressed',
        ...(uncovered && { uncovered: true }),
        ...(hint && { hint }),
      });
    } else if (actual.max < lo(expected)) {
      changes.push({ ...entry, status: 'improved' });
    }
  };
  const zero: Stat = { median: 0, min: 0, max: 0 };

  for (const scenario of Object.keys(current.scenarios).sort(cmp)) {
    const expectedPhases = snapshot.scenarios[scenario];
    const actualPhases = current.scenarios[scenario] ?? {};
    const known = knownIn(expectedPhases);
    const phaseNames = inOrder(
      [...Object.keys(actualPhases), ...Object.keys(expectedPhases ?? {})],
      Object.keys(actualPhases),
    );
    for (const phase of phaseNames) {
      const reportPhase = report.scenarios[scenario]?.phases[phase];
      const rawExp = expectedPhases?.[phase];
      const exp = rawExp ? alignKeys(rawExp, reportPhase?.components ?? {}) : undefined;
      if (!exp) {
        changes.push({
          scenario,
          phase,
          metric: 'commits',
          expected: null,
          actual: reportPhase ? toCount(reportPhase.commits) : 0,
          status: 'new',
        });
        continue;
      }
      // Extra commits (e.g. setState-in-effect cascades) are a regression on their own.
      // One extra commit (a framework scheduling detail) is tolerated in phases that
      // already commit; component counts still catch every extra render.
      const commitSlack = hi(exp.commits) > 0 ? Math.max(tolerance, 1) : tolerance;
      check(
        { scenario, phase },
        'commits',
        exp.commits,
        reportPhase?.commits ?? zero,
        undefined,
        commitSlack,
      );

      const renames = detectRenames(exp, actualPhases[phase] ?? { commits: 0, components: {} });
      for (const [from, to] of renames) {
        const e = exp.components[from];
        delete exp.components[from];
        if (e) exp.components[to] = e;
        changes.push({
          scenario,
          phase,
          component: to,
          metric: 'renders',
          expected: e?.renders ?? null,
          actual: e?.renders ?? null,
          status: 'renamed',
          renamedFrom: from,
        });
      }

      const names = [
        ...new Set([...Object.keys(exp.components), ...Object.keys(reportPhase?.components ?? {})]),
      ].sort(cmp);
      for (const component of names) {
        const e = exp.components[component];
        const full = reportPhase?.components[component];
        if (!e) {
          const status = additionStatus(full, known.has(component), failOnNewAvoidable);
          const hint = status === 'new' ? undefined : hintFor(full, reportPhase, component);
          changes.push({
            scenario,
            phase,
            component,
            metric: 'renders',
            expected: null,
            actual: full ? toCount(full.renders) : 0,
            status: status === 'regressed' ? 'regressed' : 'new',
            ...(status === 'warn' && { warning: true }),
            ...(hint && { hint }),
          });
          continue;
        }
        const base = { scenario, phase, component };
        const before = changes.length;
        check(
          base,
          'renders',
          e.renders,
          full?.renders ?? zero,
          hintFor(full, reportPhase, component),
        );
        // Same or fewer renders, more of them avoidable: the cause changed (e.g. a
        // fix removed the real input change and left a recreated prop), not the cost.
        const rendersUp = (full?.renders ?? zero).min > hi(e.renders) + tolerance;
        check(
          base,
          'avoidable',
          e.avoidable,
          full ? fixableStat(full) : zero,
          hintFor(full, reportPhase, component),
          tolerance,
          !rendersUp && !failOnMoreAvoidable,
        );
        if (e.mutable)
          for (const c of changes.slice(before)) if (c.status === 'improved') c.suspect = true;
      }
    }
  }

  // Scenarios that disappeared from the config are reported but never fail.
  for (const scenario of Object.keys(snapshot.scenarios).sort(cmp)) {
    if (!partial && !current.scenarios[scenario]) {
      changes.push({
        scenario,
        phase: '*',
        metric: 'renders',
        expected: null,
        actual: null,
        status: 'removed',
      });
    }
  }

  linkRootCauses(changes, report);
  const regressions = changes.filter((c) => c.status === 'regressed' && !c.uncovered);
  return {
    passed: regressions.length === 0,
    changes,
    regressions,
    improvements: changes.filter((c) => c.status === 'improved'),
    additions: changes.filter((c) => c.status === 'new' || c.status === 'renamed'),
  };
}

/**
 * When accepting new counts (`--update`), keeps the known variation of flaky
 * metrics: a value that varied before or varies now, and overlaps the old
 * range, is stored as the union of both, so a lucky run never narrows
 * `[12, 16]` down to `12`. Values outside the old range replace it.
 */
export function keepRanges(next: RenderSnapshot, previous: RenderSnapshot): RenderSnapshot {
  const union = (a: Count, b: Count | undefined): Count => {
    if (b === undefined || (!Array.isArray(a) && !Array.isArray(b))) return a;
    // Entirely outside the known range: a real change, not variation.
    if (hi(a) < lo(b) || lo(a) > hi(b)) return a;
    const min = Math.min(lo(a), lo(b));
    const max = Math.max(hi(a), hi(b));
    return min === max ? min : [min, max];
  };
  for (const [scenario, phases] of Object.entries(next.scenarios)) {
    for (const [phase, p] of Object.entries(phases)) {
      const old = previous.scenarios[scenario]?.[phase];
      if (!old) continue;
      p.commits = union(p.commits, old.commits);
      for (const [name, c] of Object.entries(p.components)) {
        const o = old.components[name];
        if (!o) continue;
        c.renders = union(c.renders, o.renders);
        c.avoidable = union(c.avoidable, o.avoidable);
        // Sticky: after a memo the component may no longer render to show it.
        if (o.mutable) c.mutable = true;
      }
    }
  }
  return next;
}

/**
 * Snapshot to write: the current counts, but without silently accepting
 * regressions — used to record new scenarios/phases/components on a normal run.
 */
export function mergeAdditions(snapshot: RenderSnapshot, report: CrispyReport): RenderSnapshot {
  const current = toSnapshot(report);
  const merged: RenderSnapshot = JSON.parse(JSON.stringify(snapshot));
  for (const [scenario, phases] of Object.entries(current.scenarios)) {
    const target = merged.scenarios[scenario];
    const known = knownIn(snapshot.scenarios[scenario]);
    if (!target) {
      merged.scenarios[scenario] = phases;
      continue;
    }
    for (const [phase, p] of Object.entries(phases)) {
      const t = target[phase];
      if (!t) {
        target[phase] = p;
        continue;
      }
      // Renames and clean new components are recorded; anything else waits for --update.
      for (const [from, to] of detectRenames(t, p)) {
        t.components[to] = t.components[from] as PhaseSnapshot['components'][string];
        delete t.components[from];
      }
      const full = report.scenarios[scenario]?.phases[phase]?.components ?? {};
      for (const [name, counts] of Object.entries(p.components)) {
        if (!t.components[name] && additionStatus(full[name], known.has(name)) !== 'regressed') {
          t.components[name] = counts;
        }
      }
      t.components = Object.fromEntries(
        Object.entries(t.components).sort((a, b) => cmp(a[0], b[0])),
      );
    }
  }
  // Re-serialize through toSnapshot-like ordering for stable diffs.
  const ordered: RenderSnapshot = { schemaVersion: 1, scenarios: {} };
  for (const s of Object.keys(merged.scenarios).sort(cmp)) {
    const phases = merged.scenarios[s] ?? {};
    ordered.scenarios[s] = {};
    for (const p of inOrder(Object.keys(phases), Object.keys(current.scenarios[s] ?? {}))) {
      (ordered.scenarios[s] as Record<string, PhaseSnapshot>)[p] = phases[p] as PhaseSnapshot;
    }
  }
  return ordered;
}

const ICON: Record<SnapshotStatus, string> = {
  regressed: '🔴',
  improved: '🟢',
  new: '🆕',
  renamed: '🔁',
  removed: '➖',
};

/**
 * Marks regressions caused by another regressed component in the same phase: each
 * one follows its main trigger (the component whose state update re-rendered it)
 * up to the highest regressed ancestor, so one cause is reported once.
 */
function linkRootCauses(changes: SnapshotChange[], report: CrispyReport): void {
  const regressed = new Map<string, Set<string>>();
  for (const c of changes) {
    if (c.status !== 'regressed' || !c.component) continue;
    const key = `${c.scenario}\0${c.phase}`;
    regressed.set(key, (regressed.get(key) ?? new Set()).add(c.component));
  }
  for (const c of changes) {
    if (c.status !== 'regressed' || !c.component) continue;
    const phase = report.scenarios[c.scenario]?.phases[c.phase];
    const names = regressed.get(`${c.scenario}\0${c.phase}`);
    if (!phase || !names) continue;
    let root = c.component;
    const seen = new Set([root]);
    for (;;) {
      const by = dominantTrigger(phase.components[root]?.triggeredBy, root);
      if (!by || !names.has(by) || seen.has(by)) break;
      seen.add(by);
      root = by;
    }
    if (root !== c.component) c.rootCause = root;
  }
  // The rest: the component whose state update re-rendered them, even if its own
  // count did not change (unless they are the root of other regressions).
  const roots = new Set(
    changes.map((c) => c.rootCause && `${c.scenario}\0${c.phase}\0${c.rootCause}`),
  );
  for (const c of changes) {
    if (c.status !== 'regressed' || !c.component || c.rootCause) continue;
    if (roots.has(`${c.scenario}\0${c.phase}\0${c.component}`)) continue;
    const phase = report.scenarios[c.scenario]?.phases[c.phase];
    const by = dominantTrigger(phase?.components[c.component]?.triggeredBy, c.component);
    if (by) c.rootCause = by;
  }
}

/** The component whose state updates re-rendered this one most often (not itself). */
const dominantTrigger = (triggeredBy: Record<string, number> | undefined, self: string) =>
  Object.entries(triggeredBy ?? {})
    .filter(([k]) => k !== self)
    .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];

/**
 * One Markdown row per cause: a cascade's root and what it re-renders (in every
 * scenario and phase), or the same component with the same fix across scenarios.
 */
function groupRegressions(changes: SnapshotChange[]): SnapshotChange[][] {
  const roots = new Set(changes.flatMap((c) => (c.rootCause ? [c.rootCause] : [])));
  const groups = new Map<string, SnapshotChange[]>();
  for (const c of changes) {
    const root = c.rootCause ?? (c.component && roots.has(c.component) ? c.component : undefined);
    // Without a root or a hint there is no shared cause to merge on.
    const key = root
      ? `root\0${root}`
      : c.hint
        ? `hint\0${c.component}\0${c.hint}`
        : `${c.scenario}\0${c.phase}\0${c.component}\0${c.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()];
}

const list = (items: string[], max = 3) =>
  items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ');

/** " from 1 cause" when regressions share causes. */
function causes(regressions: SnapshotChange[]): string {
  const n = groupRegressions(regressions).length;
  return n < regressions.length ? ` from ${n} cause${n === 1 ? '' : 's'}` : '';
}

export function snapshotToMarkdown(result: SnapshotResult, file: string): string {
  const lines = [
    `## 🥓 crispy render snapshots: ${
      result.passed
        ? '✅ no render regressions'
        : `❌ ${result.regressions.length} render regression(s)${causes(result.regressions)}`
    }`,
    '',
  ];
  if (result.changes.length === 0) {
    lines.push(`All render counts match \`${file}\`.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| | Scenario / phase | Component | Metric | Snapshot → now | Why / how to fix |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  const order: SnapshotStatus[] = ['regressed', 'new', 'renamed', 'improved', 'removed'];
  const sorted = [...result.changes].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );
  const valuesOf = (c: SnapshotChange) =>
    `${c.expected === null && c.actual !== null ? '0' : fmt(c.expected)} → ${fmt(c.actual)}${c.flaky ? ' (varies between runs)' : ''}`;
  const row = (c: SnapshotChange) =>
    `| ${c.warning ? '⚠️ new' : c.uncovered ? '🟡 now avoidable' : c.suspect ? '⚠️ check the UI' : `${ICON[c.status]} ${c.status}`} | ${c.scenario} / ${c.phase} | ${c.renamedFrom ? `${c.renamedFrom} → ` : ''}${c.component ?? '—'} | ${c.metric} | ${valuesOf(c)} | ${c.hint ?? ''} |`;
  const blocking = new Set(result.regressions);
  for (const group of groupRegressions(sorted.filter((c) => blocking.has(c)))) {
    // The root's own row with the biggest increase (else the group's biggest).
    const growth = (c: SnapshotChange) => hi(c.actual ?? 0) - lo(c.expected ?? 0);
    const own = group.filter((c) => !c.rootCause);
    const lead = (own.length ? own : group).reduce((a, b) => (growth(b) > growth(a) ? b : a));
    if (!lead) continue;
    if (group.length === 1) {
      lines.push(row(lead));
      continue;
    }
    const root = lead.rootCause ?? lead.component ?? '—';
    const unique = (xs: string[]) => [...new Set(xs)];
    const where = list(unique(group.map((c) => `${c.scenario} / ${c.phase}`)));
    const others = unique(group.map((c) => c.component ?? '—')).filter((k) => k !== root);
    const component = others.length ? `${root}, which re-renders ${list(others)}` : root;
    const metrics = unique(group.map((c) => c.metric)).join(', ');
    const hint = group.find((c) => c.component === root && c.hint)?.hint ?? lead.hint ?? '';
    lines.push(
      `| ❌ regressed | ${where} | ${component} | ${metrics} | ${valuesOf(lead)} (${lead.metric}); ${group.length - 1} more from this cause | ${hint} |`,
    );
  }
  for (const c of sorted) if (!blocking.has(c)) lines.push(row(c));
  lines.push('');
  if (result.improvements.length) {
    lines.push(`Improvements found: run \`crispy test --update\` to lock them into \`${file}\`.`);
    lines.push(GREEN_CAVEAT);
  }
  if (result.changes.some((c) => c.suspect)) {
    lines.push(
      '⚠️ check the UI: fewer renders on a component that reads a mutable instance (a table or form API) or data that changes without its props. A React.memo there hides those changes: make sure the screen still updates before accepting it.',
    );
  }
  if (result.changes.some((c) => c.uncovered)) {
    lines.push(
      '🟡 now avoidable: not worse. The renders are the same; you removed one cause, so the next one is visible now, with its fix. They do not fail the test.',
    );
  }
  if (result.regressions.length) {
    lines.push(
      `Fix the cause above. Only if the change is intended (a person decides, not an agent), accept it with \`crispy test --update\` and commit \`${file}\`.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

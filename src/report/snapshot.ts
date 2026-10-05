import type { ComponentReport, CrispyReport, Stat } from '../types.js';
import { cmp } from '../util/cmp.js';
import { LIBRARY_FILE } from '../util/paths.js';
import { hintFor } from './hints.js';

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
  components: Record<string, { renders: Count; avoidable: Count; file?: string }>;
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
          avoidable: toCount(r.avoidableRenders),
          ...(r.definedIn && { file: r.definedIn }),
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
          out.push(
            `          ${q(c)}: { "renders": ${q(v.renders)}, "avoidable": ${q(v.avoidable)}${file} }${comma}`,
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
  ) => {
    const flaky = Array.isArray(expected) || actual.min !== actual.max;
    const entry = { ...base, metric, expected, actual: toCount(actual), ...(flaky && { flaky }) };
    if (actual.min > hi(expected) + slack) {
      changes.push({ ...entry, status: 'regressed', ...(hint && { hint }) });
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
        check(
          base,
          'renders',
          e.renders,
          full?.renders ?? zero,
          hintFor(full, reportPhase, component),
        );
        check(
          base,
          'avoidable',
          e.avoidable,
          full?.avoidableRenders ?? zero,
          hintFor(full, reportPhase, component),
        );
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

  const regressions = changes.filter((c) => c.status === 'regressed');
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

export function snapshotToMarkdown(result: SnapshotResult, file: string): string {
  const lines = [
    `## 🥓 crispy render snapshots: ${
      result.passed
        ? '✅ no render regressions'
        : `❌ ${result.regressions.length} render regression(s)`
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
  for (const c of sorted) {
    const values = `${fmt(c.expected)} → ${fmt(c.actual)}${c.flaky ? ' (varies between runs)' : ''}`;
    lines.push(
      `| ${c.warning ? '⚠️ new' : `${ICON[c.status]} ${c.status}`} | ${c.scenario} / ${c.phase} | ${c.renamedFrom ? `${c.renamedFrom} → ` : ''}${c.component ?? '—'} | ${c.metric} | ${values} | ${c.hint ?? ''} |`,
    );
  }
  lines.push('');
  if (result.improvements.length) {
    lines.push(`Improvements found: run \`crispy test --update\` to lock them into \`${file}\`.`);
  }
  if (result.regressions.length) {
    lines.push(
      `Fix the cause above. Only if the change is intended (a person decides, not an agent), accept it with \`crispy test --update\` and commit \`${file}\`.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

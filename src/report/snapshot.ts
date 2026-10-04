import type { ComponentReport, CrispyReport, Stat } from '../types.js';
import { cmp } from '../util/cmp.js';

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
  components: Record<string, { renders: Count; avoidable: Count }>;
}

const lo = (c: Count) => (Array.isArray(c) ? c[0] : c);
const hi = (c: Count) => (Array.isArray(c) ? c[1] : c);
const toCount = (s: Stat): Count => (s.min === s.max ? s.median : [s.min, s.max]);
const fmt = (c: Count | null) =>
  c === null ? '—' : Array.isArray(c) ? `${c[0]}..${c[1]}` : `${c}`;

export type SnapshotStatus = 'regressed' | 'improved' | 'new' | 'removed';

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
}

export interface SnapshotResult {
  passed: boolean;
  changes: SnapshotChange[];
  regressions: SnapshotChange[];
  improvements: SnapshotChange[];
  /** Scenarios, phases or components that have no snapshot yet. */
  additions: SnapshotChange[];
}

const phaseOrder = (a: string, b: string) => (a === 'load' ? -1 : b === 'load' ? 1 : cmp(a, b));

export function toSnapshot(report: CrispyReport): RenderSnapshot {
  const scenarios: RenderSnapshot['scenarios'] = {};
  for (const name of Object.keys(report.scenarios).sort(cmp)) {
    const s = report.scenarios[name];
    if (!s) continue;
    const phases: Record<string, PhaseSnapshot> = {};
    for (const phase of Object.keys(s.phases).sort(phaseOrder)) {
      const p = s.phases[phase];
      if (!p) continue;
      const components: PhaseSnapshot['components'] = {};
      for (const c of Object.keys(p.components).sort(cmp)) {
        const r = p.components[c] as ComponentReport;
        components[c] = { renders: toCount(r.renders), avoidable: toCount(r.avoidableRenders) };
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
          out.push(
            `          ${q(c)}: { "renders": ${q(v.renders)}, "avoidable": ${q(v.avoidable)} }${comma}`,
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

/** Explains a regression with the data an agent or developer needs to fix it. */
function hintFor(c: ComponentReport | undefined): string | undefined {
  if (!c) return undefined;
  const where = c.locations[0] ? ` (rendered at ${c.locations[0]})` : '';
  const unstable = Object.keys(c.unstableProps);
  if (unstable.length) {
    const keys = unstable
      .slice(0, 3)
      .map((k) => `\`${k}\``)
      .join(', ');
    return `${keys} recreated on every render with the same content${where}: stabilize with useCallback/useMemo or hoist it, and wrap the child in React.memo (or enable React Compiler).`;
  }
  if (c.causes.parent > 0) {
    return `re-renders with identical props because its parent re-renders${where}: wrap in React.memo, or move the parent's state closer to where it is used.`;
  }
  if (c.causes.context > 0) {
    return `re-renders on context changes${where}: split the context or memoize the provider value.`;
  }
  if (c.causes.state > 0) {
    return `own state updates more often${where}: check for extra setState calls or effects.`;
  }
  const changed = Object.keys(c.changedProps).slice(0, 3);
  if (changed.length) return `props changed: ${changed.map((k) => `\`${k}\``).join(', ')}${where}.`;
  return undefined;
}

/**
 * Compares the current report with the committed snapshot. Any increase in
 * renders or avoidable renders is a regression; decreases are improvements that
 * can be locked in with `--update`. New components that only mount are additions.
 */
export function compareSnapshot(
  snapshot: RenderSnapshot,
  report: CrispyReport,
  tolerance = 0,
  /** When only some scenarios ran, don't report the others as removed. */
  partial = false,
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
  ) => {
    const flaky = Array.isArray(expected) || actual.min !== actual.max;
    const entry = { ...base, metric, expected, actual: toCount(actual), ...(flaky && { flaky }) };
    if (actual.min > hi(expected) + tolerance) {
      changes.push({ ...entry, status: 'regressed', ...(hint && { hint }) });
    } else if (actual.max < lo(expected)) {
      changes.push({ ...entry, status: 'improved' });
    }
  };
  const zero: Stat = { median: 0, min: 0, max: 0 };

  for (const scenario of Object.keys(current.scenarios).sort(cmp)) {
    const expectedPhases = snapshot.scenarios[scenario];
    const actualPhases = current.scenarios[scenario] ?? {};
    const phaseNames = [
      ...new Set([...Object.keys(expectedPhases ?? {}), ...Object.keys(actualPhases)]),
    ].sort(phaseOrder);
    for (const phase of phaseNames) {
      const exp = expectedPhases?.[phase];
      const reportPhase = report.scenarios[scenario]?.phases[phase];
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
      check({ scenario, phase }, 'commits', exp.commits, reportPhase?.commits ?? zero);

      const names = [
        ...new Set([...Object.keys(exp.components), ...Object.keys(reportPhase?.components ?? {})]),
      ].sort(cmp);
      for (const component of names) {
        const e = exp.components[component];
        const full = reportPhase?.components[component];
        if (!e) {
          // New UI that only mounts is an addition; new components that update are not.
          const onlyMounts = (full?.updates.median ?? 0) === 0;
          changes.push({
            scenario,
            phase,
            component,
            metric: 'renders',
            expected: null,
            actual: full ? toCount(full.renders) : 0,
            status: onlyMounts ? 'new' : 'regressed',
            ...(onlyMounts ? {} : { hint: hintFor(full) }),
          });
          continue;
        }
        const base = { scenario, phase, component };
        check(base, 'renders', e.renders, full?.renders ?? zero, hintFor(full));
        check(base, 'avoidable', e.avoidable, full?.avoidableRenders ?? zero, hintFor(full));
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
    additions: changes.filter((c) => c.status === 'new'),
  };
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
      // New components that only mount are recorded; anything else waits for --update.
      const full = report.scenarios[scenario]?.phases[phase]?.components ?? {};
      for (const [name, counts] of Object.entries(p.components)) {
        if (!t.components[name] && (full[name]?.updates.median ?? 0) === 0) {
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
    for (const p of Object.keys(phases).sort(phaseOrder)) {
      (ordered.scenarios[s] as Record<string, PhaseSnapshot>)[p] = phases[p] as PhaseSnapshot;
    }
  }
  return ordered;
}

const ICON: Record<SnapshotStatus, string> = {
  regressed: '🔴',
  improved: '🟢',
  new: '🆕',
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
  const order: SnapshotStatus[] = ['regressed', 'new', 'improved', 'removed'];
  const sorted = [...result.changes].sort(
    (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
  );
  for (const c of sorted) {
    const values = `${fmt(c.expected)} → ${fmt(c.actual)}${c.flaky ? ' (varies between runs)' : ''}`;
    lines.push(
      `| ${ICON[c.status]} ${c.status} | ${c.scenario} / ${c.phase} | ${c.component ?? '—'} | ${c.metric} | ${values} | ${c.hint ?? ''} |`,
    );
  }
  lines.push('');
  if (result.improvements.length) {
    lines.push(`Improvements found: run \`crispy test --update\` to lock them into \`${file}\`.`);
  }
  if (result.regressions.length) {
    lines.push(
      `If a regression is intended, accept it with \`crispy test --update\` and commit \`${file}\`.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

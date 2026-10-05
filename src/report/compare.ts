import type { CompareOptions } from '../config.js';
import type { CompareResult, ComponentDiff, CrispyReport } from '../types.js';
import { cmp } from '../util/cmp.js';

const DEFAULTS: CompareOptions = { rendersIncreasePct: 10, minRendersDelta: 1 };

const STATUS_ORDER: Record<ComponentDiff['status'], number> = {
  regressed: 0,
  added: 1,
  improved: 2,
  unchanged: 3,
};

/**
 * Compares two reports component by component (median renders per phase).
 * A component regresses when its renders grow by more than `rendersIncreasePct`
 * percent AND by at least `minRendersDelta`. A component missing from a phase
 * simply did not render (0 renders). Components that are new in head and only
 * mount are reported as "added" and never fail the comparison; new components
 * that also update count as regressions.
 */
export function compareReports(
  base: CrispyReport,
  head: CrispyReport,
  options: Partial<CompareOptions> = {},
): CompareResult {
  const opts = { ...DEFAULTS, ...options };
  const diffs: ComponentDiff[] = [];
  const totals = {
    baseRenders: 0,
    headRenders: 0,
    baseWasted: 0,
    headWasted: 0,
    baseAvoidable: 0,
    headAvoidable: 0,
  };

  const notCompared: string[] = [];
  const scenarioNames = [
    ...new Set([...Object.keys(base.scenarios), ...Object.keys(head.scenarios)]),
  ].sort(cmp);
  for (const scenario of scenarioNames) {
    const bs = base.scenarios[scenario];
    const hs = head.scenarios[scenario];
    const phaseNames = [
      ...new Set([...Object.keys(bs?.phases ?? {}), ...Object.keys(hs?.phases ?? {})]),
    ].sort(cmp);
    for (const phase of phaseNames) {
      const bp = bs?.phases[phase];
      const hp = hs?.phases[phase];
      // A scenario or phase that ran on one side only cannot be compared: listing
      // its components as -100% would read as a big improvement.
      if (!bp || !hp) {
        notCompared.push(`${scenario} / ${phase} (only in ${bp ? 'base' : 'head'})`);
        continue;
      }
      totals.baseRenders += bp?.totalRenders.median ?? 0;
      totals.headRenders += hp?.totalRenders.median ?? 0;
      totals.baseWasted += bp?.totalWastedRenders.median ?? 0;
      totals.headWasted += hp?.totalWastedRenders.median ?? 0;
      totals.baseAvoidable += bp?.totalAvoidableRenders?.median ?? 0;
      totals.headAvoidable += hp?.totalAvoidableRenders?.median ?? 0;
      const names = [
        ...new Set([...Object.keys(bp?.components ?? {}), ...Object.keys(hp?.components ?? {})]),
      ].sort(cmp);
      for (const component of names) {
        const bc = bp?.components[component];
        const hc = hp?.components[component];
        const baseRenders = bc?.renders.median ?? 0;
        const headRenders = hc?.renders.median ?? 0;
        const delta = headRenders - baseRenders;
        const deltaPct = baseRenders === 0 ? null : Math.round((delta / baseRenders) * 10000) / 100;
        const baseAvoidable = bc?.avoidableRenders?.median ?? 0;
        const headAvoidable = hc?.avoidableRenders?.median ?? 0;
        const grew = (b: number, h: number) =>
          h - b >= opts.minRendersDelta &&
          (b === 0 || ((h - b) / b) * 100 > opts.rendersIncreasePct);
        let status: ComponentDiff['status'];
        // New UI that only mounts is fine; something that now *re-renders* is not.
        const onlyMounts = !bc && (hc?.updates.median ?? 0) === 0;
        if (onlyMounts) status = 'added';
        // More renders, or the same renders but more of them avoidable, is a regression.
        else if (grew(baseRenders, headRenders) || grew(baseAvoidable, headAvoidable))
          status = 'regressed';
        else if (delta < 0 || headAvoidable < baseAvoidable) status = 'improved';
        else status = 'unchanged';
        const mutable =
          !!bc && (Object.keys(bc.instanceProps ?? {}).length > 0 || (bc.mutableReads ?? 0) > 0);
        diffs.push({
          scenario,
          phase,
          component,
          baseRenders,
          headRenders,
          delta,
          deltaPct,
          baseWasted: bc?.wastedRenders.median ?? 0,
          headWasted: hc?.wastedRenders.median ?? 0,
          baseAvoidable,
          headAvoidable,
          status,
          ...(status === 'improved' && mutable && { suspect: true as const }),
        });
      }
    }
  }

  diffs.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      Math.abs(b.delta) - Math.abs(a.delta) ||
      cmp(a.scenario, b.scenario) ||
      cmp(a.phase, b.phase) ||
      cmp(a.component, b.component),
  );
  const regressions = diffs.filter((d) => d.status === 'regressed');
  return {
    regressions,
    improvements: diffs.filter((d) => d.status === 'improved'),
    diffs,
    totals,
    passed: regressions.length === 0,
    ...(notCompared.length > 0 && { notCompared }),
  };
}

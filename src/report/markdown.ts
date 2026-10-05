import type { CompareResult, ComponentReport, CrispyReport } from '../types.js';
import { hintFor, rootCauses } from './hints.js';

const CAUSE_NAMES = {
  props: 'props changed',
  state: 'own state',
  context: 'context',
  unstable: 'recreated props',
  callback: 'recreated callbacks',
  parent: 'parent re-rendered',
} as const;

/** "parent re-rendered 30, own state 2": only the causes that happened, in that wording. */
const causeList = (c: ComponentReport) =>
  (Object.keys(CAUSE_NAMES) as (keyof typeof CAUSE_NAMES)[])
    .filter((k) => c.causes[k] > 0)
    .map((k) => `${CAUSE_NAMES[k]} ${c.causes[k]}`)
    .join(', ') || '—';

const esc = (s: string) => s.replace(/\|/g, '\\|');

/** Short, agent- and PR-friendly summary of a report. */
export function reportToMarkdown(report: CrispyReport, top = 10): string {
  const lines: string[] = ['## 🥓 crispy-profiling report', ''];
  lines.push(
    `React ${report.reactVersion ?? 'unknown'} · ${report.profilingBuild ? 'development/profiling build' : 'production build (component names may be minified)'}`,
    '',
  );
  for (const s of Object.values(report.scenarios)) {
    lines.push(`### Scenario \`${s.name}\` (\`${s.path}\`, ${s.runs} runs)`, '');
    for (const [phase, p] of Object.entries(s.phases)) {
      lines.push(
        `**Phase \`${phase}\`** — ${p.commits.median} React commits (screen updates), ${p.totalRenders.median} renders, **${p.totalAvoidableRenders.median + p.totalCallbackRenders.median} avoidable** (${p.totalAvoidableRenders.median} with unchanged inputs, ${p.totalCallbackRenders.median} from recreated callbacks)${p.cost ? `, **${Math.round(p.cost.scriptMs.median)} ms JavaScript** (${Math.round(p.cost.taskMs.median)} ms main thread)` : ''}`,
        '',
      );
      const causes = rootCauses(p);
      if (causes.length) {
        lines.push(
          '**Root causes — fix these first:**',
          '',
          ...causes.map((c, i) => `${i + 1}. ${c.text}`),
          '',
        );
      }
      lines.push(
        '| Component | Renders | Avoidable: unchanged inputs | Avoidable: recreated callbacks | Why it rendered | Rendered at | Why / how to fix |',
        '| --- | ---: | ---: | ---: | --- | --- | --- |',
      );
      // Top components, plus every component whose own state changed: the likely
      // root causes must never be cut off.
      const entries = Object.entries(p.components);
      const shown = entries.filter(([, c], i) => i < top || c.causes.state > 0);
      for (const [name, c] of shown) {
        const flaky = c.stable ? '' : ' ⚠️';
        const hint = hintFor(c, p, name) ?? '';
        lines.push(
          `| ${esc(name)}${flaky} | ${c.renders.median} | ${c.avoidableRenders.median} | ${c.callbackRenders.median} | ${causeList(c)} | ${c.locations.length ? c.locations.map((l) => `\`${esc(l)}\``).join(', ') : '—'} | ${esc(hint)} |`,
        );
      }
      if (entries.length > shown.length) {
        lines.push(
          '',
          `…and ${entries.length - shown.length} more component(s) in the JSON report.`,
        );
      }
      lines.push('');
    }
  }
  const warnings = Object.values(report.scenarios).flatMap((s) =>
    s.warnings.map((w) => `- \`${s.name}\` ${w}`),
  );
  if (warnings.length) lines.push('### ⚠️ Warnings', '', ...warnings, '');
  if (report.violations.length) {
    lines.push('### ❌ Budget violations', '');
    for (const v of report.violations) {
      lines.push(
        `- \`${v.scenario}\` / \`${v.phase}\`${v.component ? ` / \`${v.component}\`` : ''}: ${v.metric} = ${v.actual} (limit ${v.limit})`,
      );
    }
  } else {
    lines.push('✅ No budget violations.');
  }
  return `${lines.join('\n')}\n`;
}

export function compareToMarkdown(result: CompareResult, top = 20): string {
  const t = result.totals;
  const lines: string[] = [
    `## 🥓 crispy-profiling: ${result.passed ? '✅ no render regressions' : `❌ ${result.regressions.length} render regression(s)`}`,
    '',
    `Total renders: ${t.baseRenders} → ${t.headRenders} · Avoidable: ${t.baseAvoidable} → ${t.headAvoidable}`,
    '',
  ];
  const interesting = result.diffs.filter((d) => d.status !== 'unchanged').slice(0, top);
  if (interesting.length === 0) {
    lines.push('No component changed its render count.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '| Status | Scenario / phase | Component | Renders | Δ | Avoidable |',
    '| --- | --- | --- | ---: | ---: | ---: |',
  );
  const icon = { regressed: '🔴', added: '🆕', improved: '🟢', unchanged: '' };
  for (const d of interesting) {
    const pct = d.deltaPct === null ? '' : ` (${d.deltaPct > 0 ? '+' : ''}${d.deltaPct}%)`;
    lines.push(
      `| ${icon[d.status]} ${d.status} | ${esc(d.scenario)} / ${esc(d.phase)} | ${esc(d.component)} | ${d.baseRenders} → ${d.headRenders} | ${d.delta > 0 ? '+' : ''}${d.delta}${pct} | ${d.baseAvoidable} → ${d.headAvoidable} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

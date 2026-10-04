import type { CompareResult, CrispyReport } from '../types.js';

const esc = (s: string) => s.replace(/\|/g, '\\|');

function topKeys(counts: Record<string, number>, n = 3): string {
  const entries = Object.entries(counts).slice(0, n);
  return entries.length ? entries.map(([k, v]) => `\`${esc(k)}\`×${v}`).join(', ') : '—';
}

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
        `**Phase \`${phase}\`** — ${p.commits.median} commits, ${p.totalRenders.median} renders, ${p.totalAvoidableRenders.median} avoidable (${p.totalWastedRenders.median} wasted)`,
        '',
        '| Component | Renders | Avoidable | Causes (props/state/context/unstable/parent) | Unstable props | Changed props | Rendered at |',
        '| --- | ---: | ---: | --- | --- | --- | --- |',
      );
      for (const [name, c] of Object.entries(p.components).slice(0, top)) {
        const flaky = c.stable ? '' : ' ⚠️';
        lines.push(
          `| ${esc(name)}${flaky} | ${c.renders.median} | ${c.avoidableRenders.median} | ${c.causes.props}/${c.causes.state}/${c.causes.context}/${c.causes.unstable}/${c.causes.parent} | ${topKeys(c.unstableProps)} | ${topKeys(c.changedProps)} | ${c.locations.length ? c.locations.map((l) => `\`${esc(l)}\``).join(', ') : '—'} |`,
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

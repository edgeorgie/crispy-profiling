import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { CrispyConfig } from './config.js';
import { profile } from './profiler/run.js';
import { byCost, rootCauses } from './report/hints.js';
import {
  compareSnapshot,
  keepRanges,
  mergeAdditions,
  parseSnapshot,
  type RenderSnapshot,
  type SnapshotResult,
  serializeSnapshot,
  snapshotToMarkdown,
  toSnapshot,
} from './report/snapshot.js';
import type { CrispyReport } from './types.js';

export interface SnapshotTestOptions {
  /** Accept the current counts as the new snapshot. */
  update?: boolean;
  /** CI mode: a missing snapshot fails instead of being written. */
  ci?: boolean;
  /**
   * Read-only mode (used by the MCP server): never create or modify the snapshot,
   * even when it is missing. Only an explicit `update` writes.
   */
  readOnly?: boolean;
  /** Only run these scenarios (others keep their snapshot). */
  only?: string[];
  /** Directory the snapshot path is relative to (the config file's directory). */
  baseDir?: string;
  log?: (msg: string) => void;
}

export interface SnapshotTestOutcome {
  /** 0 = pass, 1 = regression, budget violation or missing snapshot in CI. */
  exitCode: 0 | 1;
  file: string;
  written: boolean;
  result: SnapshotResult | null;
  report: CrispyReport;
  markdown: string;
}

async function save(file: string, snapshot: RenderSnapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeSnapshot(snapshot));
}

function budgetsMarkdown(report: CrispyReport): string {
  const lines: string[] = [];
  const warnings = Object.values(report.scenarios).flatMap((s) =>
    s.warnings.map((w) => `- \`${s.name}\` ${w}`),
  );
  if (warnings.length) lines.push('', '### ⚠️ Warnings', '', ...warnings);
  if (report.violations.length) {
    lines.push('', '### ❌ Budget violations', '');
    for (const v of report.violations) {
      lines.push(
        `- \`${v.scenario}\` / \`${v.phase}\`${v.component ? ` / \`${v.component}\`` : ''}: ${v.metric} = ${v.actual} (limit ${v.limit})`,
      );
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * `crispy test`: profiles every scenario and checks the counts against the
 * committed render snapshot (like Jest snapshots, but for re-renders).
 */
/**
 * What the recorded snapshot already tells you: the top avoidable-render root
 * causes across all scenarios, so the first run is useful on its own.
 */
/** Does the scenario check the screen after its interactions? */
function hasExpect(scenario: { steps?: { action: string }[] } | undefined): boolean {
  return !!scenario?.steps?.some((st) => st.action === 'expect');
}

function insight(report: CrispyReport, max = 5, baselineMissing = false): string {
  const all = Object.values(report.scenarios).flatMap((s) =>
    Object.entries(s.phases).flatMap(([phase, p]) =>
      rootCauses(p).map((c) => ({ ...c, where: `${s.name} / ${phase}` })),
    ),
  );
  if (!all.length) {
    const avoidable = Object.values(report.scenarios)
      .flatMap((s) => Object.values(s.phases))
      .reduce((n, p) => n + p.totalAvoidableRenders.median + p.totalCallbackRenders.median, 0);
    return avoidable
      ? `\n${avoidable} avoidable render(s) recorded, but no single cause stands out: \`crispy run\` shows the hint for each component.\n`
      : '\nNo avoidable re-renders found in these flows. 🎉\n';
  }
  // Real causes first; low-impact ones only when there is nothing else.
  const major = all.filter((c) => !c.minor);
  const top = (major.length ? major : all).sort(byCost).slice(0, max);
  return [
    '',
    major.length
      ? `**Already worth fixing** (avoidable renders recorded in this snapshot):`
      : `**Small wins only** (low impact; fix them if the rest is done):`,
    '',
    ...top.map((c, i) => `${i + 1}. _${c.where}_ — ${c.text}`),
    '',
    baselineMissing
      ? 'There is nothing to compare with yet: record the baseline first (the command above), then fix one of these and run the test again: it shows 🟢 improved. Locking that in with `-u` is a person’s decision (agents: ask first).'
      : 'Fix one, then run `crispy test` again: it shows 🟢 improved. Locking that in with `-u` is a person’s decision (agents: ask first).',
    '',
  ].join('\n');
}

export async function runSnapshotTest(
  config: CrispyConfig,
  options: SnapshotTestOptions = {},
): Promise<SnapshotTestOutcome> {
  const file = resolve(options.baseDir ?? process.cwd(), config.snapshot.file);
  const shown = relative(process.cwd(), file) || file;
  // Snapshots always cover every component, even when `topComponents` trims reports.
  const report = await profile(
    { ...config, topComponents: 0 },
    { only: options.only, log: options.log, cwd: options.baseDir },
  );
  const extra = budgetsMarkdown(report);
  const budgetsFail = report.violations.length > 0;
  const previous = existsSync(file) ? parseSnapshot(await readFile(file, 'utf8')) : null;

  if (options.update || !previous) {
    if (!previous && (options.ci || (options.readOnly && !options.update))) {
      return {
        exitCode: 1,
        file,
        written: false,
        result: null,
        report,
        markdown: `## 🥓 crispy render snapshots: ❌ missing\n\nNo snapshot at \`${shown}\`. ${
          options.ci
            ? 'Run `crispy test` locally (or `crispy test -u`) and commit the file.'
            : 'Record it with `crispy test` (MCP: `test_render_snapshots` with `update: true`; a first snapshot only records the current counts) and commit the file.'
        }\n${insight(report, 5, true)}${extra}`,
      };
    }
    const snap = toSnapshot(report, config.snapshot.includeLibraries);
    let next = previous ? keepRanges(snap, previous) : snap;
    if (previous && options.only?.length) {
      // Keep the scenarios that did not run.
      next = { schemaVersion: 1, scenarios: { ...previous.scenarios, ...next.scenarios } };
      next = mergeAdditions(next, report, config.snapshot.includeLibraries);
    }
    await save(file, next);
    const result = previous
      ? compareSnapshot(
          previous,
          report,
          0,
          !!options.only?.length,
          false,
          false,
          false,
          config.snapshot.includeLibraries,
        )
      : null;
    const header = previous
      ? `## 🥓 crispy render snapshots: ✍️ updated \`${shown}\` (${result?.changes.length ?? 0} change(s) accepted)`
      : `## 🥓 crispy render snapshots: ✍️ written \`${shown}\` — commit it to start guarding re-renders`;
    return {
      exitCode: budgetsFail ? 1 : 0,
      file,
      written: true,
      result,
      report,
      markdown: `${header}\n${insight(report)}${extra}`,
    };
  }

  const result = compareSnapshot(
    previous,
    report,
    config.snapshot.tolerance,
    !!options.only?.length,
    config.snapshot.failOnNewAvoidable,
    config.snapshot.failOnMoreAvoidable,
    config.snapshot.failOnMoreCommits,
    config.snapshot.includeLibraries,
  );
  // Never modify a committed snapshot as a side effect: new entries are only
  // recorded with --update, so every change to the file is a reviewed decision.
  const written = false;
  const note = result.additions.length
    ? `\n${result.additions.length} new or renamed scenario/phase/component entr${result.additions.length === 1 ? 'y is' : 'ies are'} not in \`${shown}\` yet: run \`crispy test -u\` to record ${result.additions.length === 1 ? 'it' : 'them'}.\n`
    : '';
  // In CI a "check the UI" row fails too: fewer renders on a component that reads
  // mutable data can hide a stale screen, so a person must look and accept it
  // with --update (which locks the lower count in) instead of it passing silently.
  const suspects = options.ci ? result.changes.filter((c) => c.suspect) : [];
  const suspectNote = suspects.length
    ? `\n❌ ${suspects.length} change(s) marked ⚠️ check the UI fail in CI: open the screen and confirm it still updates, then run \`crispy test -u\` and commit \`${shown}\`. Or undo the React.memo there.\n`
    : '';
  // A component that fell to 0 renders is either a real win or a frozen screen, and crispy
  // cannot tell them apart without an `expect` step: say so, with a ready-to-edit example.
  const frozen = result.improvements.filter(
    (c) =>
      c.component &&
      c.metric === 'renders' &&
      !c.suspect &&
      c.actual === 0 &&
      !hasExpect(config.scenarios.find((sc) => sc.name === c.scenario)),
  );
  const zeroNote = frozen.length
    ? `\n💡 ${[...new Set(frozen.map((c) => `\`${c.component}\``))].slice(0, 3).join(', ')} fell to 0 renders. If ${frozen.length === 1 ? 'it shows' : 'they show'} data that should change in that interaction, a React.memo may have frozen the screen: add a step that checks it, after the interaction in scenario "${frozen[0]?.scenario}", e.g. \`{ "action": "expect", "selector": "<what it shows>", "text": "<text after the interaction>" }\`.\n`
    : '';
  return {
    exitCode: result.passed && !budgetsFail && !suspects.length ? 0 : 1,
    file,
    written,
    result,
    report,
    markdown: snapshotToMarkdown(result, shown) + suspectNote + zeroNote + note + extra,
  };
}

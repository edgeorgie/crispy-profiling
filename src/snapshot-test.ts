import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { CrispyConfig } from './config.js';
import { profile } from './profiler/run.js';
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
export async function runSnapshotTest(
  config: CrispyConfig,
  options: SnapshotTestOptions = {},
): Promise<SnapshotTestOutcome> {
  const file = resolve(options.baseDir ?? process.cwd(), config.snapshot.file);
  const shown = relative(process.cwd(), file) || file;
  // Snapshots always cover every component, even when `topComponents` trims reports.
  const report = await profile(
    { ...config, topComponents: 0 },
    { only: options.only, log: options.log },
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
        markdown: `## 🥓 crispy render snapshots: ❌ missing\n\nNo snapshot at \`${shown}\`. Run \`crispy test\` locally (or \`crispy test -u\`) and commit the file.\n${extra}`,
      };
    }
    let next = previous ? keepRanges(toSnapshot(report), previous) : toSnapshot(report);
    if (previous && options.only?.length) {
      // Keep the scenarios that did not run.
      next = { schemaVersion: 1, scenarios: { ...previous.scenarios, ...next.scenarios } };
      next = mergeAdditions(next, report);
    }
    await save(file, next);
    const result = previous ? compareSnapshot(previous, report, 0, !!options.only?.length) : null;
    const header = previous
      ? `## 🥓 crispy render snapshots: ✍️ updated \`${shown}\` (${result?.changes.length ?? 0} change(s) accepted)`
      : `## 🥓 crispy render snapshots: ✍️ written \`${shown}\` — commit it to start guarding re-renders`;
    return {
      exitCode: budgetsFail ? 1 : 0,
      file,
      written: true,
      result,
      report,
      markdown: `${header}\n${extra}`,
    };
  }

  const result = compareSnapshot(
    previous,
    report,
    config.snapshot.tolerance,
    !!options.only?.length,
  );
  // Never modify a committed snapshot as a side effect: new entries are only
  // recorded with --update, so every change to the file is a reviewed decision.
  const written = false;
  const note = result.additions.length
    ? `\n${result.additions.length} new or renamed scenario/phase/component entr${result.additions.length === 1 ? 'y is' : 'ies are'} not in \`${shown}\` yet: run \`crispy test -u\` to record ${result.additions.length === 1 ? 'it' : 'them'}.\n`
    : '';
  return {
    exitCode: result.passed && !budgetsFail ? 0 : 1,
    file,
    written,
    result,
    report,
    markdown: snapshotToMarkdown(result, shown) + note + extra,
  };
}

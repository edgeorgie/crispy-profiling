#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG_FILE, exampleConfig, loadConfig } from './config.js';
import { profile } from './profiler/run.js';
import { serializeReport } from './report/aggregate.js';
import { compareReports } from './report/compare.js';
import { compareToMarkdown, reportToMarkdown } from './report/markdown.js';
import { runSnapshotTest } from './snapshot-test.js';
import type { CrispyReport } from './types.js';
import { VERSION } from './version.js';

const HELP = `crispy ${VERSION} — deterministic React render profiling

Usage:
  crispy init [--base-url <url>]            Create ${DEFAULT_CONFIG_FILE}
  crispy install [--with-deps]              Download the Chromium build crispy uses
  crispy run [options]                      Run scenarios and write a report
      -c, --config <file>      Config file (default: ${DEFAULT_CONFIG_FILE})
      -o, --out <file>         JSON report path (default: .crispy/report.json)
      -s, --scenario <name>    Only run this scenario (repeatable)
          --markdown <file>    Also write a Markdown summary
          --no-fail            Exit 0 even if budgets are exceeded
  crispy test [options]                     Check render counts against the committed snapshot
      -c, --config <file>      Config file (default: ${DEFAULT_CONFIG_FILE})
      -u, --update             Accept current counts as the new snapshot
          --ci / --no-ci       Fail if the snapshot is missing (default: on in CI)
      -s, --scenario <name>    Only run this scenario (repeatable)
          --markdown <file>    Also write the result as Markdown
  crispy compare <base.json> <head.json> [options]
          --threshold <pct>    Allowed render increase in % (default: 10)
          --min-delta <n>      Minimum absolute increase to count (default: 1)
          --markdown <file>    Write the comparison as Markdown
          --json <file>        Write the comparison as JSON
          --no-fail            Exit 0 even if there are regressions
  crispy mcp                                Start the MCP server on stdio
  crispy --version | --help

Exit codes: 0 ok · 1 budget violation / regression · 2 usage or runtime error`;

const log = (msg: string) => process.stderr.write(`${msg}\n`);

/** Detects CI providers: generic `CI` (true/1) plus common provider variables. */
function isCI(env = process.env): boolean {
  const ci = env.CI?.toLowerCase();
  if (ci === 'true' || ci === '1') return true;
  return [
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TF_BUILD',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'BITBUCKET_BUILD_NUMBER',
  ].some((k) => Boolean(env[k]));
}

async function write(path: string, content: string): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function readReport(path: string): Promise<CrispyReport> {
  const json = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (json?.schemaVersion !== 1) throw new Error(`${path} is not a crispy-profiling report`);
  return json as CrispyReport;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  switch (command) {
    case 'init': {
      const { values } = parseArgs({ args: rest, options: { 'base-url': { type: 'string' } } });
      if (existsSync(DEFAULT_CONFIG_FILE)) {
        log(`${DEFAULT_CONFIG_FILE} already exists, not overwriting.`);
        return 2;
      }
      await write(
        DEFAULT_CONFIG_FILE,
        `${JSON.stringify(exampleConfig(values['base-url']), null, 2)}\n`,
      );
      log(
        `Created ${DEFAULT_CONFIG_FILE}. Edit the scenario steps, start your dev server, then run ` +
          `"crispy test" to record crispy.snap.json (commit it) or "crispy run" for a one-off report.`,
      );
      return 0;
    }
    case 'install': {
      // Use the exact playwright-core crispy depends on, so browser revisions match.
      const require = createRequire(import.meta.url);
      const cliPath = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
      const child = spawn(process.execPath, [cliPath, 'install', ...rest, 'chromium'], {
        stdio: 'inherit',
      });
      return new Promise<number>((done) => child.on('exit', (code) => done(code ?? 2)));
    }
    case 'run': {
      const { values } = parseArgs({
        args: rest,
        options: {
          config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_FILE },
          out: { type: 'string', short: 'o', default: '.crispy/report.json' },
          scenario: { type: 'string', short: 's', multiple: true },
          markdown: { type: 'string' },
          'no-fail': { type: 'boolean', default: false },
        },
      });
      const config = await loadConfig(values.config);
      const report = await profile(config, { only: values.scenario, log });
      await write(values.out, serializeReport(report));
      log(`[crispy] report written to ${values.out}`);
      const md = reportToMarkdown(report);
      if (values.markdown) await write(values.markdown, md);
      process.stdout.write(md);
      return report.violations.length > 0 && !values['no-fail'] ? 1 : 0;
    }
    case 'test': {
      const { values } = parseArgs({
        args: rest,
        options: {
          config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_FILE },
          update: { type: 'boolean', short: 'u', default: false },
          ci: { type: 'boolean' },
          'no-ci': { type: 'boolean' },
          scenario: { type: 'string', short: 's', multiple: true },
          markdown: { type: 'string' },
        },
      });
      const config = await loadConfig(values.config);
      const outcome = await runSnapshotTest(config, {
        update: values.update,
        ci: values['no-ci'] ? false : (values.ci ?? isCI()),
        only: values.scenario,
        baseDir: dirname(resolve(values.config)),
        log,
      });
      if (values.markdown) await write(values.markdown, outcome.markdown);
      process.stdout.write(outcome.markdown);
      return outcome.exitCode;
    }
    case 'compare': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          threshold: { type: 'string', default: '10' },
          'min-delta': { type: 'string', default: '1' },
          markdown: { type: 'string' },
          json: { type: 'string' },
          'no-fail': { type: 'boolean', default: false },
        },
      });
      const [basePath, headPath] = positionals;
      if (!basePath || !headPath) {
        log('Usage: crispy compare <base.json> <head.json>');
        return 2;
      }
      const threshold = Number(values.threshold);
      const minDelta = Number(values['min-delta']);
      if (!Number.isFinite(threshold) || !Number.isInteger(minDelta)) {
        log('--threshold must be a number and --min-delta an integer');
        return 2;
      }
      const result = compareReports(await readReport(basePath), await readReport(headPath), {
        rendersIncreasePct: threshold,
        minRendersDelta: minDelta,
      });
      const md = compareToMarkdown(result);
      if (values.markdown) await write(values.markdown, md);
      if (values.json) await write(values.json, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(md);
      return result.passed || values['no-fail'] ? 0 : 1;
    }
    case 'mcp': {
      const { startStdioServer } = await import('./mcp/server.js');
      await startStdioServer();
      return -1; // keep the process alive
    }
    default:
      log(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: Error) => {
    log(`[crispy] ${err.message}`);
    process.exitCode = 2;
  },
);

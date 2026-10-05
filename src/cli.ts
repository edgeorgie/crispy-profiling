#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type CrispyConfigInput,
  DEFAULT_CONFIG_FILE,
  exampleConfig,
  loadConfig,
  parseConfig,
} from './config.js';
import { detectApp } from './detect.js';
import { launchBrowser, profile } from './profiler/run.js';
import { startWebServer } from './profiler/webserver.js';
import { serializeReport } from './report/aggregate.js';
import { compareReports } from './report/compare.js';
import { compareToMarkdown, reportToMarkdown } from './report/markdown.js';
import { scan, scanConfig } from './scan.js';
import { runSnapshotTest } from './snapshot-test.js';
import type { CrispyReport } from './types.js';
import { isCI } from './util/ci.js';
import { VERSION } from './version.js';

const HELP = `crispy ${VERSION} — deterministic React render profiling

Usage:
  crispy scan [url] [options]               Zero config: find interactions, profile them, save them
          --routes <n>         Routes to visit (default 3)
          --actions <n>        Interactions per route (default 5)
          --allow-writes       Let interactions send POST/PUT/DELETE (blocked by default)
  crispy init [--base-url <url>]            Create ${DEFAULT_CONFIG_FILE}
  crispy install [--with-deps] [--verbose]  Download the Chromium build crispy uses
  crispy login [-c <config>] [--path /login] Sign in by hand in a browser window; saves the session
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
  // `crispy <command> --help` shows the help instead of an unknown-option error.
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(HELP);
    return 0;
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
      const app = detectApp(process.cwd());
      const baseUrl = values['base-url'] ?? app.baseUrl;
      await write(
        DEFAULT_CONFIG_FILE,
        `${JSON.stringify(exampleConfig(baseUrl, app.devCommand), null, 2)}\n`,
      );
      const found = app.framework === 'unknown' ? '' : ` (${app.framework} app at ${baseUrl})`;
      log(
        `Created ${DEFAULT_CONFIG_FILE}${found}. ` +
          (app.devCommand
            ? `crispy will start your dev server with "${app.devCommand}". `
            : 'Start your dev server first. ') +
          `Edit the scenario steps, then run "npx crispy test" to record crispy.snap.json (commit it).`,
      );
      return 0;
    }
    case 'scan': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          routes: { type: 'string', default: '3' },
          actions: { type: 'string', default: '5' },
          'allow-writes': { type: 'boolean', default: false },
        },
      });
      const maxRoutes = Number(values.routes);
      const maxActions = Number(values.actions);
      if (
        !Number.isInteger(maxRoutes) ||
        !Number.isInteger(maxActions) ||
        maxRoutes < 1 ||
        maxActions < 1
      ) {
        log('--routes and --actions must be positive integers');
        return 2;
      }
      // Base settings: the URL given, else the existing config, else what init would detect.
      const [url] = positionals;
      const hasConfig = existsSync(DEFAULT_CONFIG_FILE);
      let base: CrispyConfigInput;
      let path = '/';
      // Session, login and timing settings of an existing config apply to any URL.
      const existing = hasConfig
        ? (({ scenarios: _, ...rest }) => rest)(
            JSON.parse(await readFile(DEFAULT_CONFIG_FILE, 'utf8')),
          )
        : null;
      if (url) {
        let u: URL;
        try {
          u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
        } catch {
          log(`Not a URL: ${url} (e.g. http://localhost:5173/)`);
          return 2;
        }
        base = { ...(existing ?? {}), baseUrl: u.origin, scenarios: [] };
        if (existing && existing.baseUrl !== u.origin)
          delete (base as { webServer?: unknown }).webServer;
        path = `${u.pathname}${u.search}${u.hash}`;
      } else if (existing) {
        base = existing;
      } else {
        const app = detectApp(process.cwd());
        base = {
          baseUrl: app.baseUrl,
          ...(app.devCommand && { webServer: { command: app.devCommand } }),
          scenarios: [],
        };
      }
      const config = parseConfig({ ...base, scenarios: [{ name: 'scan' }] });
      const result = await scan(config, {
        path,
        maxRoutes,
        maxActions,
        allowWrites: values['allow-writes'],
        log,
        cwd: process.cwd(),
      });
      await write('.crispy/scan.json', serializeReport(result.report));
      const target = hasConfig ? 'crispy.scan.json' : DEFAULT_CONFIG_FILE;
      const { scenarios: _ignored, ...settings } = base as CrispyConfigInput & {
        scenarios?: unknown;
      };
      await write(
        target,
        `${JSON.stringify(scanConfig(settings as CrispyConfigInput, result.scenarios), null, 2)}\n`,
      );
      const lines = [
        `crispy scan: ${result.scenarios.length} interaction(s) profiled${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`,
        '',
      ];
      if (result.causes.length) {
        lines.push('Top root causes (most avoidable renders first):');
        for (const [i, c] of result.causes.slice(0, 8).entries()) {
          lines.push(`${i + 1}. [${c.where}] ${c.text}`);
        }
      } else {
        const total = Object.values(result.report.scenarios).reduce((sum, sc) => {
          const p = sc.phases.interaction;
          return sum + (p ? p.totalAvoidableRenders.median + p.totalCallbackRenders.median : 0);
        }, 0);
        lines.push(
          total
            ? `${total} avoidable render(s) in total, spread thin: no single cause is worth fixing yet.`
            : 'No avoidable renders in these interactions.',
        );
      }
      lines.push(
        '',
        hasConfig
          ? `Scenarios saved to crispy.scan.json (your ${DEFAULT_CONFIG_FILE} was not touched): copy the ones you want into it.`
          : `Scenarios saved to ${DEFAULT_CONFIG_FILE}. Next: "npx crispy test" records crispy.snap.json; commit both and CI fails on new re-renders. (crispy test runs each scenario 3 times, "runs" in the config; the scan ran it twice to be quick.)`,
        'Full report: .crispy/scan.json',
      );
      // Reports are per-run output, not source: keep them out of git (if it is a git repo).
      if (existsSync('.git') || existsSync('.gitignore')) {
        const ignore = existsSync('.gitignore') ? await readFile('.gitignore', 'utf8') : '';
        if (!/^\/?\.crispy\/?$/m.test(ignore)) {
          await writeFile(
            '.gitignore',
            `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}.crispy/\n`,
          );
          lines.push('Added .crispy/ (reports) to .gitignore.');
        }
      }
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'login': {
      const { values } = parseArgs({
        args: rest,
        options: {
          config: { type: 'string', short: 'c', default: DEFAULT_CONFIG_FILE },
          path: { type: 'string' },
          out: { type: 'string' },
        },
      });
      const config = await loadConfig(values.config);
      const dir = dirname(resolve(values.config));
      const out = resolve(dir, values.out ?? config.storageState ?? 'crispy.auth.json');
      const server = config.webServer
        ? await startWebServer({ ...config.webServer, cwd: dir }, config.baseUrl, log)
        : { stop: async () => {}, url: config.baseUrl };
      try {
        let browser: Awaited<ReturnType<typeof launchBrowser>>;
        try {
          browser = await launchBrowser({
            ...config,
            browser: { ...config.browser, headless: false },
          });
        } catch (err) {
          throw /display|DISPLAY|headed/i.test((err as Error).message)
            ? new Error(
                'crispy login opens a browser window and needs a display. Run it on your machine (not in CI or a container) and commit nothing: keep the session file local or in a CI secret.',
              )
            : err;
        }
        try {
          const context = await browser.newContext({ viewport: config.viewport });
          const page = await context.newPage();
          const path = values.path ?? config.login?.path ?? '/';
          await page.goto(new URL(path, server.url).toString());
          log('[crispy] sign in in the browser window, then close the window to save the session.');
          await page.waitForEvent('close', { timeout: 0 });
          await context.storageState({ path: out });
        } finally {
          await browser.close().catch(() => {});
        }
      } finally {
        await server.stop();
      }
      log(
        `[crispy] session saved to ${out}. Add "storageState": "${relative(dir, out)}" to your config, ` +
          'and keep the file out of git (it contains your cookies).',
      );
      return 0;
    }
    case 'install': {
      /** The most telling line of Playwright's output, without its stack trace. */
      const lastError = (out: string) =>
        out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !/^at\s|^\|/.test(l))
          .reverse()
          .find((l) => /error|fail/i.test(l)) ?? 'unknown error';
      // Use the exact playwright-core crispy depends on, so browser revisions match.
      const require = createRequire(import.meta.url);
      const cliPath = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
      const own = process.env.CRISPY_CHROMIUM_PATH;
      if (own && existsSync(own)) {
        log(`[crispy] CRISPY_CHROMIUM_PATH is set (${own}): nothing to download.`);
        return 0;
      }
      // Capture Playwright's output (repeated progress lines, stack traces): one line
      // while it downloads, and a short explanation if it fails. --verbose shows it all.
      const verbose = rest.includes('--verbose');
      const args = rest.filter((a) => a !== '--verbose');
      log('[crispy] Downloading Chromium for crispy (about 150 MB, once)…');
      const child = spawn(process.execPath, [cliPath, 'install', ...args, 'chromium'], {
        stdio: ['inherit', verbose ? 'inherit' : 'pipe', 'pipe'],
      });
      let errors = '';
      const keep = (d: unknown) => {
        errors += String(d);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      return new Promise<number>((done) =>
        child.on('exit', (code) => {
          if (!code) log('[crispy] Chromium is ready.');
          if (code) {
            const blocked =
              /\b(403|407|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|certificate)\b/i.test(errors);
            log(
              blocked
                ? '[crispy] Could not download Chromium: the network blocked it (proxy or firewall).'
                : `[crispy] Could not download Chromium: ${lastError(errors)} (details: npx crispy install --verbose)`,
            );
            log(
              '[crispy] Use a Chrome or Chromium you already have instead: set CRISPY_CHROMIUM_PATH=/path/to/chrome, or "browser": { "channel": "chrome" } in crispy.config.json. Behind a proxy, HTTPS_PROXY also works for the download.',
            );
          }
          // Runtime errors exit 2 (1 is reserved for regressions and budgets).
          done(code ? 2 : 0);
        }),
      );
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
      const report = await profile(config, {
        only: values.scenario,
        log,
        cwd: dirname(resolve(values.config)),
      });
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

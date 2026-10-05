import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { type CrispyConfigInput, parseConfig } from './config.js';
import { PageProfiler } from './profiler/run.js';
import { buildReport } from './report/aggregate.js';
import {
  compareSnapshot,
  parseSnapshot,
  serializeSnapshot,
  snapshotToMarkdown,
  toSnapshot,
} from './report/snapshot.js';
import type { CrispyReport } from './types.js';
import { isCI } from './util/ci.js';

/**
 * Any Playwright `Page` (from @playwright/test or playwright-core, any version):
 * typed structurally so versions do not clash.
 */
export type PlaywrightPage = { url(): string; goto: (...args: never[]) => unknown };

export interface RendersOptions {
  /** Config options (clock, random, includeInternals, snapshot.tolerance…); baseUrl is not needed. */
  config?: Partial<CrispyConfigInput>;
  /** Where render snapshots are stored (default: `__renders__`, relative to the working directory). */
  snapshotDir?: string;
  /** Accept new counts (default: the CRISPY_UPDATE=1 environment variable). */
  update?: boolean;
  /** Missing snapshots fail instead of being written (default: the CI environment variable). */
  ci?: boolean;
}

/**
 * Records React renders in a Playwright test, so existing e2e tests can guard
 * re-renders without separate crispy scenarios:
 *
 *   const r = await renders(page);          // before page.goto
 *   await page.goto('/');
 *   await r.phase('search');
 *   await page.fill('#q', 'shoes');
 *   await r.toMatchSnapshot('search');       // fails with the cause and the fix
 */
export async function renders(
  page: PlaywrightPage,
  options: RendersOptions = {},
): Promise<RenderRecorder> {
  const p = page as unknown as Page;
  if (p.url() !== 'about:blank') {
    throw new Error(
      'crispy: call renders(page) before page.goto(): it must install its hook before React loads.',
    );
  }
  const config = parseConfig({
    baseUrl: 'http://localhost',
    runs: 1,
    ...options.config,
    scenarios: [{ name: 'test' }],
  });
  const profiler = await PageProfiler.attach(p, config);
  return new RenderRecorder(profiler, config, options);
}

export class RenderRecorder {
  private phases = ['load'];

  constructor(
    private readonly profiler: PageProfiler,
    private readonly config: ReturnType<typeof parseConfig>,
    private readonly options: RendersOptions,
  ) {}

  /** Renders from now on are recorded in this phase (the app must be loaded). */
  async phase(name: string): Promise<void> {
    await this.profiler.settle(`before phase ${name}`);
    await this.profiler.phase(name);
    if (!this.phases.includes(name)) this.phases.push(name);
  }

  /** Waits until the network and React are idle, then builds the report so far. */
  async report(name = 'test'): Promise<CrispyReport> {
    await this.profiler.settle('report');
    const raw = await this.profiler.collect(this.phases);
    const scenario = { ...(this.config.scenarios[0] as (typeof this.config.scenarios)[0]), name };
    return buildReport([{ scenario, runs: [raw] }], { ...this.config, topComponents: 0 });
  }

  /**
   * Compares the renders so far with `<snapshotDir>/<name>.snap.json` (written on
   * first use). Throws with the regressions, their causes and fixes.
   */
  async toMatchSnapshot(name: string): Promise<void> {
    const report = await this.report(name);
    const file = resolve(this.options.snapshotDir ?? '__renders__', `${name}.snap.json`);
    const update = this.options.update ?? process.env.CRISPY_UPDATE === '1';
    const ci = this.options.ci ?? isCI();
    if (!existsSync(file) || update) {
      if (!existsSync(file) && ci && !update) {
        throw new Error(
          `No render snapshot at ${file}. Run the test locally (or with CRISPY_UPDATE=1) and commit it.`,
        );
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, serializeSnapshot(toSnapshot(report)));
      return;
    }
    const previous = parseSnapshot(await readFile(file, 'utf8'));
    const result = compareSnapshot(
      previous,
      report,
      this.config.snapshot.tolerance,
      false,
      this.config.snapshot.failOnNewAvoidable,
      this.config.snapshot.failOnMoreAvoidable,
    );
    if (!result.passed) {
      // One remedy that fits Playwright tests (not the CLI's `crispy test --update`).
      const report = snapshotToMarkdown(result, file).replace(
        /\nIf a regression is intended.*\n?$/s,
        '\n',
      );
      throw new Error(
        `${report}\nIf this is intended, re-run with CRISPY_UPDATE=1 and commit ${file}.`,
      );
    }
  }
}

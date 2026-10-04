import { existsSync } from 'node:fs';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { CrispyConfig, Scenario, Step } from '../config.js';
import { buildReport } from '../report/aggregate.js';
import type { CrispyReport, RawRun } from '../types.js';
import { crispyHookSource } from './hook.js';

export interface RunOptions {
  /** Only run the scenarios with these names. */
  only?: string[];
  /** Called with human-readable progress messages. */
  log?: (msg: string) => void;
}

const DEFAULT_PHASE_AFTER_LOAD = 'interaction';

/**
 * Resolves a Chromium binary. Order: config, CRISPY_CHROMIUM_PATH, Playwright's
 * own resolution (requires `npx playwright install chromium`).
 */
function resolveExecutable(config: CrispyConfig): string | undefined {
  if (config.browser.executablePath) return config.browser.executablePath;
  const fromEnv = process.env.CRISPY_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return undefined;
}

export async function launchBrowser(config: CrispyConfig): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: config.browser.headless,
      executablePath: resolveExecutable(config),
      channel: config.browser.channel,
    });
  } catch (err) {
    throw new Error(
      `Could not launch Chromium. Install it with "npx playwright install chromium", ` +
        `or set CRISPY_CHROMIUM_PATH / browser.executablePath / browser.channel.\n${(err as Error).message}`,
    );
  }
}

/**
 * Waits until React has not committed for `settleMs`, counting from whichever
 * is later: the last commit or the moment we started waiting. That guarantees
 * at least `settleMs` after every step, so async renders (fetch, timers) land
 * in the right phase.
 */
async function settle(page: Page, settleMs: number, timeoutMs: number): Promise<void> {
  const startedAt = await page.evaluate(() => performance.now());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idleFor = await page.evaluate((since) => {
      const s = (window as any).__CRISPY__;
      return performance.now() - Math.max(s.lastCommitAt, since);
    }, startedAt);
    if (idleFor >= settleMs) return;
    await page.waitForTimeout(Math.min(settleMs - idleFor + 5, 100));
  }
}

async function setPhase(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    (window as any).__CRISPY__.phase = n;
  }, name);
}

async function runStep(page: Page, step: Step, baseUrl: string, timeoutMs: number): Promise<void> {
  const opts = { timeout: timeoutMs };
  switch (step.action) {
    case 'click':
      return page.click(step.selector, opts);
    case 'hover':
      return page.hover(step.selector, opts);
    case 'fill':
      return page.fill(step.selector, step.value, opts);
    case 'type':
      return page.locator(step.selector).pressSequentially(step.value, {
        delay: step.delayMs ?? 0,
        timeout: timeoutMs,
      });
    case 'press':
      if (step.selector) return page.press(step.selector, step.key, opts);
      return page.keyboard.press(step.key);
    case 'waitFor':
      await page.waitForSelector(step.selector, opts);
      return;
    case 'wait':
      return page.waitForTimeout(step.ms);
    case 'scroll':
      await page.evaluate(
        ({ y, selector }) => {
          const el = selector ? document.querySelector(selector) : null;
          if (el) el.scrollTop = y;
          else window.scrollTo(0, y);
        },
        { y: step.y, selector: step.selector },
      );
      return;
    case 'goto':
      await page.goto(new URL(step.path, baseUrl).toString(), { ...opts, waitUntil: 'load' });
      return;
    case 'phase':
      return setPhase(page, step.name);
  }
}

export async function runScenarioOnce(
  browser: Browser,
  config: CrispyConfig,
  scenario: Scenario,
): Promise<RawRun> {
  const context = await browser.newContext({ viewport: config.viewport });
  try {
    const page = await context.newPage();
    await page.addInitScript({ content: crispyHookSource() });
    const url = new URL(scenario.path, config.baseUrl).toString();
    await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    try {
      await page.waitForFunction(() => (window as any).__CRISPY__?.reactDetected === true, null, {
        timeout: config.timeoutMs,
      });
    } catch {
      throw new Error(`React was not detected on ${url}. Is it a React (>=16) app?`);
    }
    await settle(page, config.settleMs, config.timeoutMs);

    const hasExplicitPhase = scenario.steps[0]?.action === 'phase';
    if (scenario.steps.length > 0 && !hasExplicitPhase) {
      await setPhase(page, DEFAULT_PHASE_AFTER_LOAD);
    }
    for (const step of scenario.steps) {
      await runStep(page, step, config.baseUrl, config.timeoutMs);
      if (step.action !== 'phase') await settle(page, config.settleMs, config.timeoutMs);
    }

    const raw = await page.evaluate(() => {
      const s = (window as any).__CRISPY__;
      return JSON.parse(
        JSON.stringify({
          reactVersion: s.reactVersion,
          profilingBuild: s.profilingBuild,
          phases: s.phases,
          vitals: s.vitals,
          error: s.error ?? null,
        }),
      );
    });
    if (raw.error) throw new Error(`crispy hook failed in the page: ${raw.error}`);
    return raw as RawRun;
  } finally {
    await context.close();
  }
}

export async function profile(
  config: CrispyConfig,
  options: RunOptions = {},
): Promise<CrispyReport> {
  const log = options.log ?? (() => {});
  const scenarios = options.only?.length
    ? config.scenarios.filter((s) => options.only?.includes(s.name))
    : config.scenarios;
  if (scenarios.length === 0) throw new Error(`No scenarios match: ${options.only?.join(', ')}`);

  const browser = await launchBrowser(config);
  try {
    const results: { scenario: Scenario; runs: RawRun[] }[] = [];
    for (const scenario of scenarios) {
      const runs: RawRun[] = [];
      for (let i = 0; i < config.runs; i++) {
        log(`[crispy] ${scenario.name}: run ${i + 1}/${config.runs}`);
        runs.push(await runScenarioOnce(browser, config, scenario));
      }
      results.push({ scenario, runs });
    }
    return buildReport(results, config);
  } finally {
    await browser.close();
  }
}

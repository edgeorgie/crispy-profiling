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

/** Requests that never "finish" by design; they must not block settling. */
const LONG_LIVED_TYPES = new Set(['websocket', 'eventsource']);
const POLL_MS = 25;
const CLOCK_START = Date.UTC(2026, 0, 1);

/**
 * Tracks in-flight network requests so a step is only considered settled when
 * the data it triggered has arrived (and React has rendered it).
 */
class NetworkTracker {
  private inflight = new Map<object, number>();
  lastActivity = Date.now();

  constructor(page: Page) {
    page.on('request', (req) => {
      if (LONG_LIVED_TYPES.has(req.resourceType())) return;
      this.inflight.set(req, Date.now());
      this.lastActivity = Date.now();
    });
    const done = (req: object) => {
      if (this.inflight.delete(req)) this.lastActivity = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  /** Requests younger than `maxAgeMs` (older ones are treated as long-polling). */
  pending(maxAgeMs: number): number {
    const now = Date.now();
    let n = 0;
    for (const started of this.inflight.values()) if (now - started < maxAgeMs) n++;
    return n;
  }
}

interface SettleContext {
  page: Page;
  network: NetworkTracker;
  config: CrispyConfig;
  warnings: string[];
}

const readActivity = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__CRISPY__;
    return {
      commits: s.commitCount as number,
      names: s.lastCommitNames as string[],
      // Interrupted concurrent renders (transitions, deferred values) commit later.
      busy: Boolean(s.hasPendingWork?.()),
    };
  });

function warnNotSettled(ctx: SettleContext, label: string, names: string[]): void {
  const busy = names.length ? ` Last commit rendered: ${names.slice(0, 5).join(', ')}.` : '';
  ctx.warnings.push(
    ctx.config.clock
      ? `${label}: still committing after ${ctx.config.maxSettleMs} ms of virtual time (timers keep firing); counting stopped there, so counts stay deterministic.${busy}`
      : `${label}: page did not settle within ${ctx.config.maxSettleMs} ms (React kept committing or requests stayed in flight); counts may vary.${busy} If the app polls or animates, set "clock": true to control timers.`,
  );
}

/**
 * Real-time settle: done when there were no React commits, no network activity
 * and no in-flight requests for `settleMs`.
 */
async function settleRealTime(ctx: SettleContext, label: string): Promise<void> {
  const { page, network, config } = ctx;
  const deadline = Date.now() + config.maxSettleMs;
  let last = await readActivity(page);
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    const now = await readActivity(page);
    if (now.commits !== last.commits || now.busy) lastChange = Date.now();
    last = now;
    const quietSince = Math.max(lastChange, network.lastActivity);
    if (network.pending(config.maxSettleMs) === 0 && Date.now() - quietSince >= config.settleMs) {
      return;
    }
  }
  warnNotSettled(ctx, label, last.names);
}

/**
 * Fake-clock settle: advance virtual time in `settleMs` slices; done when a
 * slice produces no commits and no requests are in flight. Timer-driven work
 * (polling, animations) becomes deterministic because time only moves here.
 */
async function settleWithClock(ctx: SettleContext, label: string): Promise<void> {
  const { page, network, config } = ctx;
  const maxSlices = Math.ceil(config.maxSettleMs / config.settleMs);
  const realDeadline = Date.now() + config.timeoutMs;
  let last = await readActivity(page);
  for (let i = 0; i < maxSlices; i++) {
    await page.clock.runFor(config.settleMs);
    // React's scheduler and network responses run in real time: let them drain.
    while (network.pending(config.maxSettleMs) > 0 && Date.now() < realDeadline) {
      await page.waitForTimeout(POLL_MS);
    }
    await page.waitForTimeout(POLL_MS);
    const now = await readActivity(page);
    const changed = now.commits !== last.commits;
    last = now;
    if (!changed && !now.busy && network.pending(config.maxSettleMs) === 0) return;
  }
  warnNotSettled(ctx, label, last.names);
}

const settle = (ctx: SettleContext, label: string) =>
  ctx.config.clock ? settleWithClock(ctx, label) : settleRealTime(ctx, label);

/** Polled from Node: in-page rAF/timer polling would stall under a fake clock. */
async function waitForReact(page: Page, url: string, timeoutMs: number, clock: boolean) {
  const deadline = Date.now() + timeoutMs;
  while (!(await page.evaluate(() => (window as any).__CRISPY__?.reactDetected === true))) {
    if (Date.now() > deadline) {
      throw new Error(`React was not detected on ${url}. Is it a React (>=16) app?`);
    }
    if (clock) await page.clock.runFor(POLL_MS);
    await page.waitForTimeout(POLL_MS);
  }
}

async function setPhase(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    (window as any).__CRISPY__.phase = n;
  }, name);
}

async function runStep(
  page: Page,
  step: Step,
  baseUrl: string,
  timeoutMs: number,
  clock: boolean,
  settleKey?: () => Promise<void>,
): Promise<void> {
  const opts = { timeout: timeoutMs };
  switch (step.action) {
    case 'click':
      return page.click(step.selector, opts);
    case 'hover':
      return page.hover(step.selector, opts);
    case 'fill':
      return page.fill(step.selector, step.value, opts);
    case 'type': {
      // One key at a time, settling after each: concurrent features
      // (useDeferredValue, transitions) would otherwise skip a CPU-dependent
      // number of intermediate renders.
      const input = page.locator(step.selector);
      for (const ch of step.value) {
        await input.pressSequentially(ch, { timeout: timeoutMs });
        if (step.delayMs) await page.waitForTimeout(step.delayMs);
        if (settleKey) await settleKey();
      }
      return;
    }
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
      await waitForReact(page, page.url(), timeoutMs, clock);
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
    const warnings: string[] = [];
    const ctx: SettleContext = { page, network: new NetworkTracker(page), config, warnings };
    // A fixed start time keeps Date-dependent output identical between runs.
    if (config.clock) {
      // install() lets time flow; pausing makes it advance only through runFor().
      await page.clock.install({ time: CLOCK_START });
      await page.clock.pauseAt(CLOCK_START + 1);
    }
    await page.addInitScript({ content: crispyHookSource() });
    const url = new URL(scenario.path, config.baseUrl).toString();
    await page.goto(url, { waitUntil: 'load', timeout: config.timeoutMs });
    await waitForReact(page, url, config.timeoutMs, config.clock);
    await settle(ctx, 'load');

    const hasExplicitPhase = scenario.steps[0]?.action === 'phase';
    if (scenario.steps.length > 0 && !hasExplicitPhase) {
      await setPhase(page, DEFAULT_PHASE_AFTER_LOAD);
    }
    for (const [i, step] of scenario.steps.entries()) {
      await runStep(page, step, config.baseUrl, config.timeoutMs, config.clock, () =>
        settle(ctx, `step ${i + 1} (${step.action})`),
      );
      if (step.action !== 'phase') await settle(ctx, `step ${i + 1} (${step.action})`);
    }

    const raw = await page.evaluate(() => {
      const s = (window as any).__CRISPY__;
      return JSON.parse(
        JSON.stringify({
          reactVersion: s.reactVersion,
          profilingBuild: s.profilingBuild,
          phases: s.phases,
          vitals: s.vitals,
          hookErrors: s.hookErrors ?? null,
        }),
      );
    });
    if (raw.hookErrors) {
      warnings.push(
        `the render hook could not analyze ${raw.hookErrors.count} component render(s); they are missing from the counts (first error: ${raw.hookErrors.first}). Please report it with your React version.`,
      );
    }
    delete raw.hookErrors;
    return { ...raw, warnings } as RawRun;
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

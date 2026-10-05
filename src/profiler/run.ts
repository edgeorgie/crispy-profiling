import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { type CrispyConfig, phasesOf, type Scenario, type Step } from '../config.js';
import { buildReport } from '../report/aggregate.js';
import type { CrispyReport, RawRun } from '../types.js';
import { resolveDefinitions, trackScripts } from './definitions.js';
import { crispyHookSource } from './hook.js';
import { SourceMapResolver } from './sourcemaps.js';
import { startWebServer } from './webserver.js';

export interface RunOptions {
  /** Only run the scenarios with these names. */
  only?: string[];
  /** Called with human-readable progress messages. */
  log?: (msg: string) => void;
  /** Directory where `webServer.command` runs (default: the current directory). */
  cwd?: string;
}

const DEFAULT_PHASE_AFTER_LOAD = 'interaction';

/**
 * Resolves a Chromium binary. Order: config, CRISPY_CHROMIUM_PATH, Playwright's
 * own resolution (requires `npx crispy-profiling install`).
 */
function resolveExecutable(config: CrispyConfig): string | undefined {
  if (config.browser.executablePath) return config.browser.executablePath;
  const fromEnv = process.env.CRISPY_CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return undefined;
}

/** Math.random with a fixed seed (mulberry32): same sequence in every run and document. */
const SEEDED_RANDOM = `(() => {
  let s = 0x2f6b9c1d;
  Math.random = function random() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

/** `${NAME}` in typed values comes from the environment, so credentials stay out of the config. */
/** `$${NAME}` types a literal `${NAME}`. */
export const withEnv = (value: string) =>
  value.replace(/(\$?)\$\{(\w+)\}/g, (match, escaped: string, name: string) => {
    if (escaped) return match.slice(1);
    const v = process.env[name];
    if (v === undefined)
      throw new Error(`Environment variable ${name} is not set (used in a step value).`);
    return v;
  });

/** Drops Playwright's boxed "run npx playwright install" banner: crispy has its own command. */
const withoutBanner = (message: string) =>
  message
    .split('\n')
    .filter((l) => !/[╔╗╚╝║═]/.test(l))
    .join('\n')
    .trim();

/** Turns "connection refused" into an actionable message. */
async function gotoApp(page: Page, url: string, timeout: number): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout });
  } catch (err) {
    const message = (err as Error).message;
    if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET/.test(message)) {
      throw new Error(
        `Nothing is listening at ${new URL(url).origin}. Is the dev server running? Start it (e.g. "npm run dev") and check baseUrl in crispy.config.json.`,
      );
    }
    throw err;
  }
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
      `Could not launch Chromium. Install it with "npx crispy-profiling install", ` +
        `or set CRISPY_CHROMIUM_PATH / browser.executablePath / browser.channel.\n${withoutBanner((err as Error).message)}`,
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
/** Uncaught page errors, so "React was not detected" can say why. */
const pageErrors = new WeakMap<Page, string[]>();

/**
 * Waits until React is loaded and has committed its first render: apps that
 * boot asynchronously (e.g. start a mock service worker first) render after
 * the load event, and those renders belong to the `load` phase.
 */
async function waitForReact(page: Page, url: string, timeoutMs: number, clock: boolean) {
  const deadline = Date.now() + timeoutMs;
  const status = () =>
    page.evaluate(() => {
      const s = (window as any).__CRISPY__;
      return { react: s?.reactDetected === true, rendered: (s?.commitCount ?? 0) > 0 };
    });
  for (let st = await status(); !(st.react && st.rendered); st = await status()) {
    if (Date.now() > deadline) {
      const errors = (pageErrors.get(page) ?? []).slice(0, 3);
      const why = errors.length
        ? `\nPage errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`
        : '';
      throw new Error(
        st.react
          ? `React loaded on ${url} but never rendered.${why}`
          : `React was not detected on ${url}. Is it a React (>=16) app in development mode?${why}`,
      );
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
      return page.fill(step.selector, withEnv(step.value), opts);
    case 'type': {
      // One key at a time, settling after each: concurrent features
      // (useDeferredValue, transitions) would otherwise skip a CPU-dependent
      // number of intermediate renders.
      const input = page.locator(step.selector);
      for (const ch of withEnv(step.value)) {
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
      await page.waitForSelector(step.selector, { ...opts, state: step.state ?? 'visible' });
      return;
    case 'select':
      await page.selectOption(step.selector, step.value, opts);
      return;
    case 'drag': {
      const from = await page.locator(step.selector).first().boundingBox({ timeout: timeoutMs });
      if (!from) throw new Error(`drag: "${step.selector}" is not visible`);
      const x = from.x + from.width / 2;
      const y = from.y + from.height / 2;
      let tx = x + (step.dx ?? 0);
      let ty = y + (step.dy ?? 0);
      if (step.to) {
        const to = await page.locator(step.to).first().boundingBox({ timeout: timeoutMs });
        if (!to) throw new Error(`drag: target "${step.to}" is not visible`);
        tx = to.x + to.width / 2;
        ty = to.y + to.height / 2;
      }
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(tx, ty, { steps: step.steps ?? 10 });
      await page.mouse.up();
      return;
    }
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

/** Maps every raw "url:line:col (Owner)" location to original "file:line (Owner)". */
async function rewriteLocations(raw: RawRun, sourceMaps: SourceMapResolver): Promise<void> {
  // "@owner:Key (Owner)" (React <= 19.0, no owner stacks) → "<owner's file> (Owner)".
  const place = async (loc: string): Promise<string | null> => {
    const owner = loc.match(/^@owner:(.+?)( \(.*\))$/);
    if (!owner) return sourceMaps.rewriteLocation(loc);
    const file = raw.definitions?.[owner[1] as string];
    return file ? `${file}${owner[2]}` : null;
  };
  for (const phase of Object.values(raw.phases)) {
    for (const c of Object.values(phase.components)) {
      const next: Record<string, number> = {};
      for (const [loc, n] of Object.entries(c.locations ?? {})) {
        const mapped = await place(loc);
        if (mapped) next[mapped] = (next[mapped] ?? 0) + n;
      }
      c.locations = next;
      const providers: Record<string, number> = {};
      for (const [loc, n] of Object.entries(c.providerAt ?? {})) {
        const mapped = await place(loc);
        if (!mapped) continue;
        providers[mapped] = (providers[mapped] ?? 0) + n;
      }
      c.providerAt = providers;
    }
  }
}

/**
 * Profiles renders on a Playwright page: installs the hook before the app
 * loads and collects deterministic render data. Used by the scenario runner
 * and by the Playwright Test integration (`crispy-profiling/playwright`).
 */
export class PageProfiler {
  private definitions: Record<string, string> = {};
  private ambiguous = new Set<string>();

  private constructor(
    readonly page: Page,
    private readonly cdp: CDPSession,
    private readonly scripts: Map<string, string>,
    private readonly sourceMaps: SourceMapResolver,
    readonly ctx: SettleContext,
  ) {}

  /** Call before the page navigates to the app. */
  static async attach(page: Page, config: CrispyConfig): Promise<PageProfiler> {
    const warnings: string[] = [];
    const ctx: SettleContext = { page, network: new NetworkTracker(page), config, warnings };
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on('pageerror', (err) => errors.push(err.message.split('\n')[0] ?? err.message));
    // A fixed start time keeps Date-dependent output identical between runs.
    if (config.clock) {
      // install() lets time flow; pausing makes it advance only through runFor().
      await page.clock.install({ time: CLOCK_START });
      await page.clock.pauseAt(CLOCK_START + 1);
    }
    const cdp = await page.context().newCDPSession(page);
    const scripts = await trackScripts(cdp);
    if (config.cpuThrottle > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: config.cpuThrottle });
    }
    if (config.random === 'seeded') await page.addInitScript({ content: SEEDED_RANDOM });
    await page.addInitScript({ content: crispyHookSource() });
    const sourceMaps = new SourceMapResolver(async (u) => {
      try {
        if (/^https?:\/\//.test(u)) {
          const res = await page.context().request.get(u, { timeout: config.timeoutMs });
          return res.ok() ? await res.text() : null;
        }
        // Scripts without a fetchable URL (webpack eval modules, inline scripts):
        // read their source from the page through the DevTools protocol.
        for (const [scriptId, url] of scripts) {
          if (url === u) {
            const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId });
            return scriptSource;
          }
        }
        return null;
      } catch {
        return null;
      }
    });
    return new PageProfiler(page, cdp, scripts, sourceMaps, ctx);
  }

  get warnings(): string[] {
    return this.ctx.warnings;
  }

  /** Waits until React has rendered (after a navigation). */
  waitForReact(url: string): Promise<void> {
    return waitForReact(this.page, url, this.ctx.config.timeoutMs, this.ctx.config.clock);
  }

  /** Waits until the network and React are idle. */
  settle(label: string): Promise<void> {
    return settle(this.ctx, label);
  }

  /** Renders from now on are recorded in this phase. */
  phase(name: string): Promise<void> {
    return setPhase(this.page, name);
  }

  /**
   * Definitions live in the page, so collect them before every navigation too.
   * A key bound to different files in different documents is ambiguous: drop it.
   */
  async collectDefinitions(): Promise<void> {
    const found = await resolveDefinitions(
      this.page,
      this.cdp,
      this.scripts,
      this.sourceMaps,
    ).catch(() => ({}));
    for (const [k, f] of Object.entries(found)) {
      if (this.ambiguous.has(k)) continue;
      if (this.definitions[k] === undefined) this.definitions[k] = f;
      else if (this.definitions[k] !== f) {
        this.ambiguous.add(k);
        delete this.definitions[k];
      }
    }
  }

  /** Raw render data recorded so far, with source-mapped locations. */
  async collect(declaredPhases: string[] = []): Promise<RawRun> {
    await this.collectDefinitions();
    const raw = await this.page.evaluate(() => {
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
    const warnings = [...this.warnings];
    if (raw.hookErrors) {
      warnings.push(
        `the render hook could not analyze ${raw.hookErrors.count} component render(s); they are missing from the counts (first error: ${raw.hookErrors.first}). Please report it with your React version.`,
      );
    }
    delete raw.hookErrors;
    raw.definitions = { ...this.definitions };
    // Every declared phase is reported, even with no renders: an empty phase is
    // part of the snapshot, so renders appearing there later are a regression.
    for (const phase of declaredPhases) {
      raw.phases[phase] ??= { commits: 0, components: {} };
    }
    await rewriteLocations(raw as RawRun, this.sourceMaps);
    return { ...raw, warnings } as RawRun;
  }
}

export async function runScenarioOnce(
  browser: Browser,
  config: CrispyConfig,
  scenario: Scenario,
  storageState?: StorageState,
): Promise<RawRun> {
  const context = await browser.newContext({ viewport: config.viewport, storageState });
  try {
    const page = await context.newPage();
    const profiler = await PageProfiler.attach(page, config);
    const url = new URL(scenario.path, config.baseUrl).toString();
    await gotoApp(page, url, config.timeoutMs);
    await profiler.waitForReact(url);
    await profiler.settle('load');

    const hasExplicitPhase = scenario.steps[0]?.action === 'phase';
    if (scenario.steps.length > 0 && !hasExplicitPhase) {
      await profiler.phase(DEFAULT_PHASE_AFTER_LOAD);
    }
    for (const [i, step] of scenario.steps.entries()) {
      if (step.action === 'goto') await profiler.collectDefinitions();
      try {
        await runStep(page, step, config.baseUrl, config.timeoutMs, config.clock, () =>
          profiler.settle(`step ${i + 1} (${step.action})`),
        );
      } catch (err) {
        const what = 'selector' in step ? `${step.action} "${step.selector}"` : step.action;
        throw new Error(
          `Scenario "${scenario.name}", step ${i + 1} (${what}) failed: ${(err as Error).message.split('\n')[0]}\n` +
            'Check that the selector matches a visible element on that page, and edit the steps in your crispy config.',
        );
      }
      if (step.action !== 'phase') await profiler.settle(`step ${i + 1} (${step.action})`);
    }
    return await profiler.collect(phasesOf(scenario));
  } finally {
    await context.close();
  }
}

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * Signs in once before profiling, so apps behind a login can be profiled:
 * either a saved session file (`storageState`, e.g. from `crispy login`) or
 * scripted `login` steps. Login renders are never part of any phase.
 */
async function authenticate(
  browser: Browser,
  config: CrispyConfig,
  cwd: string | undefined,
  log: (msg: string) => void,
): Promise<StorageState | undefined> {
  const file = config.storageState ? resolve(cwd ?? process.cwd(), config.storageState) : undefined;
  if (file && !existsSync(file)) {
    throw new Error(`Session file not found: ${file}. Create it with "crispy login".`);
  }
  if (!config.login) return file ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  log('[crispy] signing in');
  const context = await browser.newContext({ viewport: config.viewport, storageState: file });
  try {
    const page = await context.newPage();
    await gotoApp(page, new URL(config.login.path, config.baseUrl).toString(), config.timeoutMs);
    for (const step of config.login.steps) {
      await runStep(page, step, config.baseUrl, config.timeoutMs, false);
    }
    await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {});
    return await context.storageState();
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

  let stopServer = async () => {};
  if (config.webServer) {
    const server = await startWebServer(
      { ...config.webServer, cwd: options.cwd },
      config.baseUrl,
      log,
    );
    stopServer = server.stop;
    if (server.url !== config.baseUrl) config = { ...config, baseUrl: server.url };
  }
  let browser: Browser;
  try {
    browser = await launchBrowser(config);
  } catch (err) {
    await stopServer();
    throw err;
  }
  try {
    const auth = await authenticate(browser, config, options.cwd, log);
    const results: { scenario: Scenario; runs: RawRun[] }[] = [];
    for (const scenario of scenarios) {
      const runs: RawRun[] = [];
      for (let i = 0; i < config.runs; i++) {
        log(`[crispy] ${scenario.name}: run ${i + 1}/${config.runs}`);
        runs.push(await runScenarioOnce(browser, config, scenario, auth));
      }
      results.push({ scenario, runs });
    }
    return buildReport(results, config);
  } finally {
    await browser.close();
    await stopServer();
  }
}

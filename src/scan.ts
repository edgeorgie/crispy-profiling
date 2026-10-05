import type { Browser } from 'playwright-core';
import type { CrispyConfig, CrispyConfigInput, Scenario, Step } from './config.js';
import {
  authenticate,
  gotoApp,
  guardContext,
  launchBrowser,
  PageProfiler,
  profile,
} from './profiler/run.js';
import { startWebServer } from './profiler/webserver.js';
import { type RootCause, rootCauses } from './report/hints.js';
import type { CrispyReport } from './types.js';
import { cmp } from './util/cmp.js';

export interface ScanOptions {
  /** Start path (default "/"). */
  path?: string;
  /** Routes to visit, including the start page (default 3). */
  maxRoutes?: number;
  /** Interactions to try per route (default 5). */
  maxActions?: number;
  /** Runs per scenario (default 2). */
  runs?: number;
  /**
   * Let interactions send requests other than GET (default: blocked, and the
   * scenarios that tried are not saved). Only for apps with disposable data.
   */
  allowWrites?: boolean;
  log?: (msg: string) => void;
  cwd?: string;
}

export interface ScanResult {
  report: CrispyReport;
  /** Scenarios that ran, ready to save as a config. */
  scenarios: Scenario[];
  /** Scenarios that failed, with the reason. */
  skipped: { name: string; reason: string }[];
  /** Top root causes across all scenarios, most renders first. */
  causes: (RootCause & { where: string })[];
}

/**
 * Names that suggest an action with effects outside the page (data loss,
 * payments, signing out, sending), in a few languages: never clicked or
 * visited by the scan. A second line of defense: during the scan every request
 * other than GET is blocked anyway (see `allowWrites`). Flags: "iu".
 */
export const RISKY =
  '(^|[^\\p{L}])(delete|remove|destroy|erase|wipe|trash|log[ -]?out|sign[ -]?out|pay|buy|purchase|checkout|order|submit|send|publish|deploy|reset|discard|unsubscribe|archive|ban|block|clear|revoke|cancel subscription|eliminar|borrar|quitar|cerrar sesi[oó]n|pagar|comprar|enviar|supprimer|effacer|d[ée]connexion|payer|acheter|envoyer|l[öo]schen|entfernen|abmelden|kaufen|senden|excluir|apagar|remover|sair|elimina|cancella|esci|削除|删除|удалить|выйти)($|[^\\p{L}])';

interface Found {
  actions: {
    kind: 'click' | 'type' | 'select';
    selector: string;
    name: string;
    rank: number;
    value?: string;
  }[];
  links: string[];
  /** The page asks to sign in (password field or a "log in" button). */
  login: boolean;
}

/** Runs in the page: safe interactive elements and same-origin links, in DOM order. */
function discoverInPage(risky: string): Found {
  const riskyRe = new RegExp(risky, 'iu');
  const isRisky = (s: string) => riskyRe.test(s);
  // Icon-only or emoji-only names say nothing about what the action does.
  const meaningful = (s: string) => /[\p{L}\p{N}]/u.test(s);
  const multiline = (s: string | null) => s !== null && /[\r\n\t]/.test(s);
  const route = (u: URL) =>
    `${u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname}${u.hash.startsWith('#/') ? u.hash : ''}`;
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  // The page's own content first (typing renders the most), then layout chrome.
  const inMain = (el: Element) => el.closest('main, [role="main"]') !== null;
  const actions: Found['actions'] = [];
  const seen = new Set<string>();
  const clickable = document.querySelectorAll(
    'button, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], input[type="checkbox"]',
  );
  for (const el of Array.from(clickable)) {
    const h = el as HTMLButtonElement;
    if (!visible(el) || h.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('a[href]')) continue; // navigation: visited as a route instead
    if (h.type === 'submit' && (h.form || el.closest('form'))) continue;
    const role = el.tagName === 'INPUT' ? 'checkbox' : el.getAttribute('role') || 'button';
    const name = norm(el.getAttribute('aria-label') || (el as HTMLElement).innerText || h.title);
    if (!name || name.length > 40 || !meaningful(name) || isRisky(name)) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({
      kind: 'click',
      selector: `role=${role}[name=${quote(name)}] >> nth=0`,
      name,
      rank: inMain(el) ? 2 : 3,
    });
  }
  const typeable = document.querySelectorAll(
    'input:not([type]), input[type="text"], input[type="search"], textarea',
  );
  for (const el of Array.from(typeable)) {
    const h = el as HTMLInputElement;
    if (!visible(el) || h.disabled || h.readOnly) continue;
    const aria = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const field = el.getAttribute('name');
    if (multiline(aria) || multiline(placeholder) || multiline(field)) continue;
    const tag = el.tagName.toLowerCase();
    const css = aria
      ? `${tag}[aria-label=${quote(aria)}]`
      : placeholder
        ? `${tag}[placeholder=${quote(placeholder)}]`
        : field
          ? `${tag}[name=${quote(field)}]`
          : null;
    if (!css || seen.has(css)) continue;
    const name = norm(aria || placeholder || field);
    if (isRisky(name)) continue;
    seen.add(css);
    actions.push({ kind: 'type', selector: `${css} >> nth=0`, name, rank: inMain(el) ? 0 : 1 });
  }
  for (const el of Array.from(document.querySelectorAll('select'))) {
    const h = el as HTMLSelectElement;
    if (!visible(el) || h.disabled || h.multiple) continue;
    // Bulk-action menus ("Delete selected") are not navigation: skip the whole select.
    const options = Array.from(h.options);
    if (options.some((o) => isRisky(o.text) || isRisky(o.value))) continue;
    // The first option that is not the current one and has a value.
    const option = options.find((o) => !o.disabled && o.value && !o.selected);
    const aria = el.getAttribute('aria-label');
    const field = el.getAttribute('name') || el.id;
    if (multiline(aria) || multiline(field)) continue;
    const css = aria
      ? `select[aria-label=${quote(aria)}]`
      : field
        ? `select[${el.getAttribute('name') ? 'name' : 'id'}=${quote(field)}]`
        : null;
    if (!option || !css || seen.has(css)) continue;
    seen.add(css);
    const name = norm(aria || field);
    actions.push({
      kind: 'select',
      selector: css,
      name,
      rank: inMain(el) ? 0 : 1,
      value: option.value,
    });
  }
  const links: string[] = [];
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const anchor = a as HTMLAnchorElement;
    let url: URL;
    try {
      url = new URL(anchor.href, location.href);
    } catch {
      continue;
    }
    if (url.origin !== location.origin || anchor.hasAttribute('download')) continue;
    const name = norm(anchor.getAttribute('aria-label') || anchor.innerText || anchor.title);
    if (anchor.target === '_blank' || isRisky(url.pathname) || isRisky(name)) continue;
    if (/\.[a-z0-9]{2,4}$/i.test(url.pathname)) continue; // files, not routes
    const target = route(url);
    if (!links.includes(target)) links.push(target);
    // Client-side navigation is an interaction too (route transitions re-render a lot).
    const key = `link|${name}`;
    if (
      visible(a) &&
      name &&
      name.length <= 40 &&
      meaningful(name) &&
      target !== route(new URL(location.href)) &&
      !seen.has(key)
    ) {
      seen.add(key);
      actions.push({
        kind: 'click',
        selector: `role=link[name=${quote(name)}] >> nth=0`,
        name,
        rank: inMain(a) ? 4 : 5,
      });
    }
  }
  // Stable sort: by rank, then DOM order.
  const ranked = actions
    .map((a, i) => [a, i] as const)
    .sort((x, y) => x[0].rank - y[0].rank || x[1] - y[1]);
  const login =
    document.querySelector('input[type="password"]') !== null ||
    Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).some(
      (b) =>
        /^(log ?in|sign ?in)$/i.test(
          norm((b as HTMLElement).innerText || (b as HTMLInputElement).value),
        ),
    );
  return { actions: ranked.map(([a]) => a), links, login };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');

const routeName = (path: string) => slug(path.split(/[?#]/)[0] ?? '') || 'home';

/** Visits up to `maxRoutes` routes and turns their safe interactions into scenarios. */
async function discover(
  browser: Browser,
  config: CrispyConfig,
  options: Required<Pick<ScanOptions, 'path' | 'maxRoutes' | 'maxActions' | 'allowWrites'>>,
  log: (msg: string) => void,
): Promise<{ scenarios: Scenario[]; loadWrites: Set<string> }> {
  const origin = new URL(config.baseUrl).origin;
  // Writes the pages send on their own while loading (analytics, sessions): not
  // caused by an interaction, so they do not disqualify one.
  const loadWrites = new Set<string>();
  const auth = await authenticate(browser, config, undefined, log);
  const queue = [options.path];
  const visited = new Set<string>();
  const scenarios: Scenario[] = [];
  const names = new Set<string>();
  // Layout chrome (sidebars, headers) repeats on every route: scan each action once.
  const scanned = new Set<string>();
  while (queue.length && visited.size < options.maxRoutes) {
    const path = queue.shift() as string;
    if (visited.has(path)) continue;
    visited.add(path);
    const context = await browser.newContext({ viewport: config.viewport, storageState: auth });
    try {
      if (!options.allowWrites) await guardContext(context, (what) => loadWrites.add(what));
      const page = await context.newPage();
      // Same page setup and settling as profiling (hook, seeded random, network):
      // apps that boot asynchronously (e.g. a mock service worker first) render late.
      const profiler = await PageProfiler.attach(page, config);
      const url = new URL(path, config.baseUrl).toString();
      await gotoApp(page, url, config.timeoutMs);
      await profiler.waitForReact(url);
      await profiler.settle('discovery');
      // A redirect (e.g. to /login) is the route that really renders.
      const at = new URL(page.url());
      if (at.origin !== origin) {
        log(`[crispy] ${path} redirects to ${at.origin}: skipped (only ${origin} is scanned).`);
        continue;
      }
      const trimmed = at.pathname.length > 1 ? at.pathname.replace(/\/+$/, '') : at.pathname;
      const landed = `${trimmed}${at.search}${at.hash.startsWith('#/') ? at.hash : ''}`;
      if (landed !== path && visited.has(landed)) continue;
      visited.add(landed);
      // As source: bundlers with keepNames add a `__name` helper the page does not have.
      const read = (): Promise<Found> =>
        page.evaluate(
          `(() => { const __name = (f) => f; return (${discoverInPage.toString()})(${JSON.stringify(RISKY)}); })()`,
        );
      // Data can arrive after the page looks settled (options, rows): read until stable.
      // Mock APIs often add a delay of ~2 s, so the page must stay unchanged for 2 s.
      let found = await read();
      for (let i = 0, same = 0; i < 4 && same < 2; i++) {
        await page.waitForTimeout(1000);
        const again = await read();
        same = JSON.stringify(again) === JSON.stringify(found) ? same + 1 : 0;
        found = again;
      }
      let taken = 0;
      for (const action of found.actions) {
        if (taken >= options.maxActions) break;
        if (scanned.has(action.selector)) continue;
        const count = await page
          .locator(action.selector)
          .count()
          .catch(() => 0);
        if (count === 0) continue;
        scanned.add(action.selector);
        taken++;
        const base = `${routeName(landed)}-${slug(action.name) || action.kind}`;
        let name = base;
        for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
        names.add(name);
        const act: Step =
          action.kind === 'click'
            ? { action: 'click', selector: action.selector }
            : action.kind === 'select'
              ? { action: 'select', selector: action.selector, value: action.value ?? '' }
              : { action: 'type', selector: action.selector, value: 'abc' };
        scenarios.push({
          name,
          path: landed,
          steps: [
            { action: 'phase', name: 'load' },
            { action: 'waitFor', selector: action.selector },
            { action: 'phase', name: 'interaction' },
            act,
          ],
        });
      }
      log(
        `[crispy] ${landed}: ${taken} interaction(s)${found.links.length ? `, ${found.links.length} link(s)` : ''}`,
      );
      if (found.login && !config.storageState && !config.login) {
        log(
          `[crispy] ${landed} asks to sign in: run "npx crispy login" (saves a session to crispy.auth.json), add "storageState": "crispy.auth.json" to crispy.config.json and scan again to profile the app behind it.`,
        );
      }
      for (const link of found.links) if (!visited.has(link)) queue.push(link);
    } finally {
      await context.close();
    }
  }
  return { scenarios, loadWrites };
}

/**
 * Zero-config profiling: starts the app (when configured), finds safe
 * interactions on a few routes, profiles each one as its own scenario and
 * returns the root causes plus the scenarios that worked, ready to save.
 */
export async function scan(config: CrispyConfig, options: ScanOptions = {}): Promise<ScanResult> {
  const log = options.log ?? (() => {});
  const settings = {
    path: options.path ?? '/',
    maxRoutes: options.maxRoutes ?? 3,
    maxActions: options.maxActions ?? 5,
    allowWrites: options.allowWrites ?? false,
  };
  const host = new URL(config.baseUrl).hostname;
  if (!/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$|\.(local|localhost|test)$/.test(host)) {
    log(
      `[crispy] ⚠️ ${host} is not a local address. scan clicks through the app: point it at a development or preview build, never at production.`,
    );
  }
  let stopServer = async () => {};
  if (config.webServer) {
    const server = await startWebServer(
      { ...config.webServer, cwd: options.cwd },
      config.baseUrl,
      log,
    );
    stopServer = server.stop;
    config = { ...config, baseUrl: server.url };
  }
  try {
    const browser = await launchBrowser(config);
    let scenarios: Scenario[];
    let loadWrites: Set<string>;
    try {
      ({ scenarios, loadWrites } = await discover(browser, config, settings, log));
    } finally {
      await browser.close();
    }
    if (!scenarios.length) {
      throw new Error(
        `No safe interactions found on ${new URL(settings.path, config.baseUrl)}. Is the app rendering? Pass another start path, or write steps by hand with "crispy init".`,
      );
    }
    const skipped: ScanResult['skipped'] = [];
    const wrote = new Map<string, string>();
    const report = await profile(
      {
        ...config,
        webServer: undefined,
        runs: options.runs ?? 2,
        // A guessed interaction that does not work should not hold the scan for long.
        timeoutMs: Math.min(config.timeoutMs, 10_000),
        scenarios,
      },
      {
        log,
        cwd: options.cwd,
        onScenarioError: (name, err) => {
          skipped.push({ name, reason: err.message.split('\n')[0] ?? String(err) });
          log(`[crispy] skipped ${name}: ${err.message.split('\n')[0]}`);
        },
        // Read-only: writes never leave the browser, and those scenarios are not saved.
        ...(!settings.allowWrites && {
          onBlockedRequest: (name: string, what: string) => {
            if (!loadWrites.has(what) && !wrote.has(name)) wrote.set(name, what);
          },
        }),
      },
    );
    for (const [name, what] of wrote) {
      skipped.push({ name, reason: `tried to send ${what} (blocked, not saved)` });
      log(`[crispy] not saved: ${name} tried to send ${what} (blocked)`);
      delete report.scenarios[name];
    }
    const ran = scenarios.filter((s) => report.scenarios[s.name]);
    if (!ran.length) {
      throw new Error(
        `None of the ${scenarios.length} interaction(s) found could be profiled:\n${skipped
          .slice(0, 5)
          .map((s) => `  - ${s.name}: ${s.reason}`)
          .join('\n')}\nWrite the steps by hand with "crispy init".`,
      );
    }
    // Load phases repeat per route: keep the first scenario's.
    const causes: ScanResult['causes'] = [];
    const seenText = new Set<string>();
    const loadDone = new Set<string>();
    for (const s of ran) {
      const phases = report.scenarios[s.name]?.phases ?? {};
      for (const [phase, data] of Object.entries(phases)) {
        if (phase === 'load' && loadDone.has(s.path)) continue;
        if (phase === 'load') loadDone.add(s.path);
        for (const c of rootCauses(data)) {
          if (seenText.has(c.text)) continue;
          seenText.add(c.text);
          causes.push({ ...c, where: phase === 'load' ? `${s.path} (load)` : s.name });
        }
      }
    }
    causes.sort((a, b) => b.renders - a.renders || cmp(a.text, b.text));
    return { report, scenarios: ran, skipped, causes };
  } finally {
    await stopServer();
  }
}

/** A config with the scanned scenarios, ready for `crispy test`. */
export function scanConfig(
  base: CrispyConfigInput,
  scenarios: Scenario[],
): CrispyConfigInput & { scenarios: Scenario[] } {
  return {
    $schema: './node_modules/crispy-profiling/schema/crispy.config.schema.json',
    ...base,
    runs: 3,
    scenarios,
  };
}

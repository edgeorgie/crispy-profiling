import type { CDPSession, Page } from 'playwright-core';
import { shortPath } from '../util/paths.js';

/**
 * Tracks script URLs by CDP script id, so a function's [[FunctionLocation]] can
 * be turned into the file that defines it.
 */
export async function trackScripts(cdp: CDPSession): Promise<Map<string, string>> {
  const scripts = new Map<string, string>();
  cdp.on('Debugger.scriptParsed', (e) => {
    if (e.url) scripts.set(e.scriptId, e.url);
  });
  await cdp.send('Debugger.enable');
  return scripts;
}

/**
 * Resolves, for every component key seen by the hook, the file where the
 * component function is defined. This gives same-named components a stable,
 * source-based identity that does not depend on render order.
 */
export async function resolveDefinitions(
  page: Page,
  cdp: CDPSession,
  scripts: Map<string, string>,
): Promise<Record<string, string>> {
  const keys = await page.evaluate(() => Object.keys((window as any).__CRISPY__?.typeRefs ?? {}));
  const out: Record<string, string> = {};
  const objectGroup = 'crispy-definitions';
  try {
    for (const key of keys) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `window.__CRISPY__.typeRefs[${JSON.stringify(key)}]`,
        objectGroup,
      });
      if (!result.objectId) continue;
      const props = await cdp.send('Runtime.getProperties', {
        objectId: result.objectId,
        ownProperties: true,
      });
      const location = props.internalProperties?.find((p) => p.name === '[[FunctionLocation]]')
        ?.value?.value as { scriptId: string } | undefined;
      const url = location ? scripts.get(location.scriptId) : undefined;
      if (url) out[key] = shortPath(url);
    }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
  return out;
}

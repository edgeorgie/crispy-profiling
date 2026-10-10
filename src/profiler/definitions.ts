import type { CDPSession, Page } from 'playwright-core';
import { shortPath } from '../util/paths.js';
import type { SourceMapResolver } from './sourcemaps.js';

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

/** Where the declared name starts in "function Name(", "async function Name(" or "class Name". */
const DECLARATION = /^(?:async\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/;

/**
 * Resolves, for every component key seen by the hook, the file where the
 * component function is defined. This gives same-named components a stable,
 * source-based identity that does not depend on render order. Also returns the
 * name written in the source when the bundler renamed the function: esbuild turns
 * `memo(function Member…)` into `Member2` when `const Member` is in scope.
 */
export async function resolveDefinitions(
  page: Page,
  cdp: CDPSession,
  scripts: Map<string, string>,
  sourceMaps?: SourceMapResolver,
): Promise<{
  files: Record<string, string>;
  /** key -> `file:line` of the definition: tells apart same-named functions in one file. */
  lines: Record<string, string>;
  names: Record<string, string>;
}> {
  const keys = await page.evaluate(() => Object.keys((window as any).__CRISPY__?.typeRefs ?? {}));
  const out: Record<string, string> = {};
  const lines: Record<string, string> = {};
  const names: Record<string, string> = {};
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
        ?.value?.value as
        | { scriptId: string; lineNumber: number; columnNumber: number }
        | undefined;
      const url = location ? scripts.get(location.scriptId) : undefined;
      if (!url || !location) continue;
      // Original source file when a source map is available (bundles, transforms).
      const mapped = await sourceMaps?.resolve(
        url,
        location.lineNumber + 1,
        location.columnNumber + 1,
      );
      out[key] = mapped?.file ?? shortPath(url);
      lines[key] = `${out[key]}:${mapped?.line ?? location.lineNumber + 1}`;
      const original = sourceMaps
        ? await originalName(cdp, result.objectId, url, location, sourceMaps)
        : undefined;
      if (original) names[key] = original;
    }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
  return { files: out, lines, names };
}

/**
 * The name the function has in the source file, when it differs from the one in
 * the bundle. The source map records it at the position of the declared name.
 */
async function originalName(
  cdp: CDPSession,
  objectId: string,
  url: string,
  location: { lineNumber: number; columnNumber: number },
  sourceMaps: SourceMapResolver,
): Promise<string | undefined> {
  const { result } = await cdp
    .send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){return Function.prototype.toString.call(this).slice(0,200)}',
      returnByValue: true,
    })
    .catch(() => ({ result: { value: '' } }));
  const head = String(result.value ?? '');
  const m = head.match(DECLARATION);
  if (!m?.[1]) return undefined;
  const nameAt = head.indexOf(m[1]);
  // V8 points a function at its parameter list but a class at the `class` keyword.
  const paren = head.startsWith('class') ? 0 : head.indexOf('(', nameAt);
  const offset = nameAt - paren;
  // The generated name must sit on the same line as the position V8 reports.
  if (
    nameAt < 0 ||
    paren < 0 ||
    head.slice(Math.min(nameAt, paren), Math.max(nameAt, paren)).includes('\n')
  ) {
    return undefined;
  }
  const mapped = await sourceMaps.resolve(
    url,
    location.lineNumber + 1,
    location.columnNumber + 1 + offset,
  );
  return mapped?.name && mapped.name !== m[1] && /^[A-Za-z_$][\w$]*$/.test(mapped.name)
    ? mapped.name
    : undefined;
}

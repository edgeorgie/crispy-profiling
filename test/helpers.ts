import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, 'fixtures', 'app');

const HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

/** Bundles the fixture app (React development build) in "slow" and "fast" variants. */
export async function buildFixture(): Promise<Record<'slow' | 'fast', string>> {
  // A fresh directory per call: test files run in parallel.
  const root = mkdtempSync(join(tmpdir(), 'crispy-fixture-'));
  const out = { slow: join(root, 'slow'), fast: join(root, 'fast') };
  for (const [variant, dir] of Object.entries(out)) {
    mkdirSync(dir, { recursive: true });
    await build({
      entryPoints: [join(appDir, 'App.tsx')],
      bundle: true,
      outfile: join(dir, 'bundle.js'),
      format: 'iife',
      jsx: 'automatic',
      sourcemap: 'inline',
      define: { __FAST__: String(variant === 'fast'), 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    });
    writeFileSync(join(dir, 'index.html'), HTML);
    // The same bundle executed through eval with a webpack-internal:/// URL, like
    // webpack's development "eval-source-map" mode (its inline map stays inside).
    const code = readFileSync(join(dir, 'bundle.js'), 'utf8');
    writeFileSync(
      join(dir, 'bundle-eval.js'),
      `eval(${JSON.stringify(`${code}\n//# sourceURL=webpack-internal:///(app-pages-browser)/./src/bundle.js\n`)});\n`,
    );
    writeFileSync(join(dir, 'eval.html'), HTML.replace('/bundle.js', '/bundle-eval.js'));
  }
  return out;
}

/** Minimal static server; returns its base URL and a close function. */
export async function serve(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    // Slow API to reproduce data arriving well after the interaction.
    if (req.url?.startsWith('/api/slow')) {
      setTimeout(() => res.end('loaded'), 600);
      return;
    }
    const url = req.url ?? '/';
    const file = url.startsWith('/bundle-eval.js')
      ? 'bundle-eval.js'
      : url.startsWith('/bundle.js')
        ? 'bundle.js'
        : url.startsWith('/eval')
          ? 'eval.html'
          : 'index.html';
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(readFileSync(join(dir, file)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/**
 * Serves the `modules` fixture as separate ES modules (like a Vite dev server):
 * one URL per source file, React from a single vendored module via an import map.
 */
export async function buildModuleFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'crispy-modules-'));
  const src = join(here, 'fixtures', 'modules');
  await build({
    stdin: {
      contents:
        // CommonJS React has no static ESM exports: re-export what the fixture uses.
        "import * as React from 'react'; import { createRoot } from 'react-dom/client'; import { jsxDEV, Fragment } from 'react/jsx-dev-runtime'; export const useState = React.useState; export { createRoot, jsxDEV, Fragment };",
      resolveDir: here,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    outfile: join(dir, 'vendor.js'),
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  writeFileSync(join(dir, 'react.js'), "export * from './vendor.js';\n");
  for (const file of ['main', 'ListItem', 'BannerItem']) {
    const code = readFileSync(join(src, `${file}.tsx`), 'utf8');
    const out = await transform(code, {
      loader: 'tsx',
      jsx: 'automatic',
      jsxDev: true,
      sourcefile: `src/${file}.tsx`,
      sourcemap: 'inline',
    });
    writeFileSync(join(dir, `${file}.js`), out.code);
  }
  // A fake library served from node_modules: LibButton is rendered by the app,
  // LibInner only by the library (an "internal").
  mkdirSync(join(dir, 'node_modules', 'fake-lib'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'fake-lib', 'index.js'),
    [
      "import { jsxDEV } from 'react/jsx-dev-runtime';",
      "function LibInner() { return jsxDEV('span', { children: 'lib' }); }",
      'export function LibButton({ onClick }) {',
      "  return jsxDEV('button', { id: 'lib', onClick, children: jsxDEV(LibInner, {}) });",
      '}',
      '',
    ].join('\n'),
  );
  const importMap = {
    imports: {
      'fake-lib': '/node_modules/fake-lib/index.js',
      react: '/react.js',
      'react-dom/client': '/react.js',
      'react/jsx-dev-runtime': '/react.js',
    },
  };
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><script type="importmap">${JSON.stringify(importMap)}</script></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`,
  );
  return dir;
}

/** Static server for the modules fixture: serves /<name>.js and index.html. */
export async function serveModules(
  dir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]?.replace(/^\//, '') ?? '';
    const file = name.endsWith('.js') ? name : 'index.html';
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    try {
      res.end(readFileSync(join(dir, file)));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

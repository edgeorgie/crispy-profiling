import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
      define: { __FAST__: String(variant === 'fast'), 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
    });
    writeFileSync(join(dir, 'index.html'), HTML);
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
    const file = req.url?.startsWith('/bundle.js') ? 'bundle.js' : 'index.html';
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

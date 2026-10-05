import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DetectedApp {
  framework: 'next' | 'vite' | 'react-router' | 'cra' | 'unknown';
  baseUrl: string;
  /** Command that starts the dev server, e.g. "pnpm run dev". */
  devCommand: string | null;
}

/**
 * Guesses how to run a React app from its package.json: framework, dev URL and
 * dev command (with the project's package manager), so `crispy init` produces
 * a config that works without editing.
 */
export function detectApp(dir: string): DetectedApp {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const has = (name: string) => name in deps;

  const framework: DetectedApp['framework'] = has('next')
    ? 'next'
    : has('@react-router/dev')
      ? 'react-router'
      : has('vite')
        ? 'vite'
        : has('react-scripts')
          ? 'cra'
          : 'unknown';

  const script = ['dev', 'start'].find((s) => scripts[s]);
  const pm = existsSync(join(dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(dir, 'yarn.lock'))
      ? 'yarn'
      : existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
        ? 'bun'
        : 'npm';

  // An explicit --port / -p in the dev script wins over the framework default.
  const portInScript = script
    ? scripts[script]?.match(/(?:--port|-p)[= ](\d{2,5})/)?.[1]
    : undefined;
  const defaultPort = framework === 'next' || framework === 'cra' ? 3000 : 5173;
  const port = portInScript ? Number(portInScript) : defaultPort;

  return {
    framework,
    baseUrl: `http://localhost:${port}`,
    devCommand: script ? `${pm} run ${script}` : null,
  };
}

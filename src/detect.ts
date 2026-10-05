import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DetectedApp {
  framework: 'next' | 'vite' | 'react-router' | 'cra' | 'unknown';
  baseUrl: string;
  /** Command that starts the dev server, e.g. "pnpm run dev". */
  devCommand: string | null;
}

type Pkg = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const readPkg = (dir: string): Pkg | null => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

/** This directory and its parents up to the filesystem root (monorepos). */
const upwards = (dir: string): string[] => {
  const dirs = [dir];
  for (let d = dirname(dir); d !== dirs[dirs.length - 1]; d = dirname(d)) dirs.push(d);
  return dirs;
};

/** Value of an environment variable defined in .env files of `dir` or its parents. */
function envVar(dir: string, name: string): string | undefined {
  for (const d of upwards(dir)) {
    let files: string[] = [];
    try {
      files = readdirSync(d).filter((f) => /^\.env(\.development)?(\.local)?$/.test(f));
    } catch {}
    for (const f of files.sort().reverse()) {
      const m = readFileSync(join(d, f), 'utf8').match(
        new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\s]+)`, 'm'),
      );
      if (m) return m[1];
    }
  }
  return undefined;
}

/** `server: { port: 3001 }` or `port: Number(env.VITE_APP_PORT || 3000)` in vite.config.* */
function vitePort(dir: string): number | undefined {
  for (const name of ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    try {
      const src = readFileSync(join(dir, name), 'utf8');
      const literal = src.match(/server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})\b/s);
      if (literal) return Number(literal[1]);
      const fromEnv = src.match(
        /\bport\s*:\s*(?:Number|parseInt)?\(?\s*[\w.]*?\b([A-Z][A-Z0-9_]*PORT)\b[^)\n]*?(?:\|\||\?\?)\s*(\d{2,5})/,
      );
      if (fromEnv) return Number(envVar(dir, fromEnv[1] as string) ?? fromEnv[2]);
    } catch {}
  }
  return undefined;
}

/** PORT=… (or VITE_PORT / NEXT_PUBLIC_PORT) in .env files. */
function envPort(dir: string): number | undefined {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\.env(\.development)?(\.local)?$/.test(f));
  } catch {}
  for (const f of files.sort()) {
    const m = readFileSync(join(dir, f), 'utf8').match(/^\s*(?:VITE_)?PORT\s*=\s*["']?(\d{2,5})/m);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Guesses how to run a React app: framework, dev URL and dev command (with the
 * project's package manager, found in this directory or a workspace root), so
 * `crispy init` produces a config that works without editing.
 */
export function detectApp(dir: string): DetectedApp {
  const pkg = readPkg(dir) ?? {};
  const scripts = pkg.scripts ?? {};
  // Workspace packages often get their tooling from the root package.json.
  const deps: Record<string, string> = {};
  for (const d of upwards(dir)) {
    const p = readPkg(d);
    Object.assign(deps, p?.devDependencies, p?.dependencies);
  }
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

  const pm =
    upwards(dir)
      .map((d) =>
        existsSync(join(d, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(d, 'yarn.lock'))
            ? 'yarn'
            : existsSync(join(d, 'bun.lock')) || existsSync(join(d, 'bun.lockb'))
              ? 'bun'
              : existsSync(join(d, 'package-lock.json'))
                ? 'npm'
                : null,
      )
      .find(Boolean) ?? 'npm';

  const script = ['dev', 'start'].find((s) => scripts[s]);
  const body = script ? (scripts[script] as string) : '';
  // Several processes (e.g. concurrently "api" "web"): a port flag may be the API's.
  const multi = /\bconcurrently\b|\bnpm-run-all\b|\brun-p\b|\s&\s/.test(body);
  const portInScript = multi ? undefined : body.match(/(?:--port|-p)[= ](\d{2,5})/)?.[1];
  const defaultPort = framework === 'next' || framework === 'cra' ? 3000 : 5173;
  const port =
    (portInScript ? Number(portInScript) : undefined) ??
    (framework === 'vite' || framework === 'react-router' ? vitePort(dir) : undefined) ??
    // Vite ignores PORT; Next.js and CRA read it.
    (framework === 'next' || framework === 'cra' ? envPort(dir) : undefined) ??
    defaultPort;

  // "yarn && vite": skip the reinstall on every run, start the tool directly.
  const install = body.match(
    /^\s*(?:yarn(?: install)?|npm (?:ci|install)|pnpm install|bun install)\s*&&\s*(.+)$/,
  );
  const devCommand = !script
    ? null
    : install
      ? `${pm === 'npm' ? 'npx' : pm === 'yarn' ? 'yarn' : `${pm} exec`} ${install[1]}`
      : `${pm} run ${script}`;

  return { framework, baseUrl: `http://localhost:${port}`, devCommand };
}

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCI } from '../util/ci.js';

export interface WebServerConfig {
  command: string;
  url?: string;
  timeoutMs: number;
  /** Default: true locally, false on CI (a server already on the port may be another app). */
  reuseExisting?: boolean;
  cwd?: string;
}

/** True when something answers HTTP at `url` (any status: the server is up). */
export async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * The package name of the app a dev server serves, when it exposes its
 * package.json (Vite does; Next.js does not): null when unknown.
 */
async function servedPackageName(url: string): Promise<string | null> {
  try {
    const res = await fetch(new URL('/package.json', url), { signal: AbortSignal.timeout(2000) });
    if (!res.ok || !/json/.test(res.headers.get('content-type') ?? '')) return null;
    const name = ((await res.json()) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

function localPackageName(cwd: string | undefined): string | null {
  try {
    const name = JSON.parse(readFileSync(join(cwd ?? process.cwd(), 'package.json'), 'utf8')).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Starts the app's dev server (like Playwright's `webServer`) unless one is
 * already running, waits until it answers, and returns a function that stops
 * it. Output is kept and shown only if the server fails to start.
 */
export async function startWebServer(
  server: WebServerConfig,
  baseUrl: string,
  log: (line: string) => void = () => {},
): Promise<{ stop: () => Promise<void>; url: string; reused?: boolean }> {
  const url = server.url ?? baseUrl;
  const reuse = server.reuseExisting ?? !isCI();
  if (await isUp(url)) {
    if (!reuse) {
      throw new Error(
        `Something is already running at ${url}. Stop it so crispy can start "${server.command}", or set webServer.reuseExisting: true if it is this app.`,
      );
    }
    // Two dev servers on the same port is common: never profile the wrong app silently.
    const served = await servedPackageName(url);
    const local = localPackageName(server.cwd);
    if (served && local && served !== local) {
      throw new Error(
        `Another app ("${served}") is running at ${url}, not this one ("${local}"). Stop it, or give this app its own port (e.g. add --port 5199 --strictPort to webServer.command and update baseUrl).`,
      );
    }
    log(
      `[crispy] ⚠️ reusing the server already running at ${url} — ${served === local && served ? `it serves "${served}", this app` : "make sure it is this app's development build"}.`,
    );
    return { stop: async () => {}, url, reused: true };
  }
  log(`[crispy] starting "${server.command}" and waiting for ${url}`);
  const child: ChildProcess = spawn(server.command, {
    shell: true,
    cwd: server.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group, so the whole tree (npm → vite) can be stopped.
    detached: process.platform !== 'win32',
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
  });
  const output: string[] = [];
  const keep = (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? 1;
  });

  const signal = (sig: NodeJS.Signals) => {
    if (exited !== null || child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {}
  };
  // Ctrl-C, a CI cancel or a crash must not leave the dev server running.
  const onSignal = (sig: NodeJS.Signals) => {
    signal('SIGTERM');
    setTimeout(() => signal('SIGKILL'), 1500).unref();
    process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 143);
  };
  const onExit = () => signal('SIGKILL');
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.once(sig, onSignal);
  process.once('exit', onExit);

  const stop = async () => {
    for (const sig of signals) process.removeListener(sig, onSignal);
    process.removeListener('exit', onExit);
    signal('SIGTERM');
    for (let i = 0; i < 20 && exited === null; i++) await new Promise((r) => setTimeout(r, 100));
    signal('SIGKILL');
  };

  // Fallback for a wrong baseUrl: the URL the dev server announces ("Local:
  // http://localhost:5174/"). Only after a grace period, only from announce
  // lines, only if it serves HTML, and never when the configured port is the
  // one being announced (it is just still starting).
  const started = Date.now();
  const grace = Math.min(10_000, server.timeoutMs / 3);
  const configuredPort = new URL(url).port;
  const announced = () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors from the output
    const text = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    const lines = text
      .split('\n')
      .filter((l) => /\b(local|ready|started|running|listening)\b/i.test(l));
    const found = lines.flatMap(
      (l) =>
        l.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s'"]*/g) ?? [],
    );
    return [...new Set(found.map((u) => u.replace('0.0.0.0', 'localhost')))];
  };
  const servesHtml = async (u: string) => {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(2000) });
      await res.body?.cancel();
      return (res.headers.get('content-type') ?? '').includes('text/html');
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + server.timeoutMs;
  let actual = url;
  while (!(await isUp(actual))) {
    const candidates = Date.now() - started > grace ? announced() : [];
    const portAnnounced = candidates.some(
      (c) => configuredPort && new URL(c).port === configuredPort,
    );
    for (const candidate of portAnnounced ? [] : candidates) {
      if (candidate !== actual && (await servesHtml(candidate))) {
        log(
          `[crispy] ⚠️ the dev server is at ${candidate}, not ${url}: using it. Set baseUrl to it in your config.`,
        );
        actual = candidate;
        break;
      }
    }
    if (actual !== url) break;
    if (exited !== null || Date.now() > deadline) {
      const crashed = exited;
      await stop();
      const tail = output.join('').split('\n').slice(-15).join('\n');
      throw new Error(
        crashed !== null
          ? `The dev server command "${server.command}" exited with code ${crashed}.\n${tail}`
          : `The dev server did not answer at ${url} within ${Math.round(server.timeoutMs / 1000)} s. Is ${url} the address it prints? Set baseUrl (or webServer.url) to it.\n${tail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { stop, url: actual };
}

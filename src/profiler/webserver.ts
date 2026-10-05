import { type ChildProcess, spawn } from 'node:child_process';
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
 * Starts the app's dev server (like Playwright's `webServer`) unless one is
 * already running, waits until it answers, and returns a function that stops
 * it. Output is kept and shown only if the server fails to start.
 */
export async function startWebServer(
  server: WebServerConfig,
  baseUrl: string,
  log: (line: string) => void = () => {},
): Promise<{ stop: () => Promise<void>; url: string }> {
  const url = server.url ?? baseUrl;
  const reuse = server.reuseExisting ?? !isCI();
  if (await isUp(url)) {
    if (!reuse) {
      throw new Error(
        `Something is already running at ${url}. Stop it so crispy can start "${server.command}", or set webServer.reuseExisting: true if it is this app.`,
      );
    }
    log(
      `[crispy] ⚠️ reusing the server already running at ${url} — make sure it is this app's development build.`,
    );
    return { stop: async () => {}, url };
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
    process.exit(sig === 'SIGINT' ? 130 : 143);
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

  // URLs the dev server prints ("Local: http://localhost:5174/"): when the
  // configured one never answers but a printed one does, use it.
  const printed = () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors from the output
    const text = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    const found =
      text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s'"]*/g) ??
      [];
    return [...new Set(found.map((u) => u.replace('0.0.0.0', 'localhost')))];
  };
  const deadline = Date.now() + server.timeoutMs;
  let actual = url;
  while (!(await isUp(actual))) {
    for (const candidate of printed()) {
      if (candidate !== actual && (await isUp(candidate))) {
        log(
          `[crispy] ⚠️ the dev server is at ${candidate}, not ${url}: using it. Set baseUrl to it in your config.`,
        );
        actual = candidate;
        break;
      }
    }
    if (actual !== url) break;
    if (exited !== null || Date.now() > deadline) {
      await stop();
      const tail = output.join('').split('\n').slice(-15).join('\n');
      throw new Error(
        exited !== null
          ? `The dev server command "${server.command}" exited with code ${exited}.\n${tail}`
          : `The dev server did not answer at ${url} within ${Math.round(server.timeoutMs / 1000)} s. Is ${url} the address it prints? Set baseUrl (or webServer.url) to it.\n${tail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { stop, url: actual };
}

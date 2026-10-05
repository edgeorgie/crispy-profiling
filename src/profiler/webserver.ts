import { type ChildProcess, spawn } from 'node:child_process';

export interface WebServerConfig {
  command: string;
  url?: string;
  timeoutMs: number;
  reuseExisting: boolean;
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
): Promise<() => Promise<void>> {
  const url = server.url ?? baseUrl;
  if (server.reuseExisting && (await isUp(url))) {
    log(`[crispy] using the server already running at ${url}`);
    return async () => {};
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

  const stop = async () => {
    if (exited !== null || child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  };

  const deadline = Date.now() + server.timeoutMs;
  while (!(await isUp(url))) {
    if (exited !== null || Date.now() > deadline) {
      await stop();
      const tail = output.join('').split('\n').slice(-15).join('\n');
      throw new Error(
        exited !== null
          ? `The dev server command "${server.command}" exited with code ${exited}.\n${tail}`
          : `The dev server did not answer at ${url} within ${server.timeoutMs} ms.\n${tail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return stop;
}

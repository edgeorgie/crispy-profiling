import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixture, serve } from './helpers.js';

const cli = resolve('src/cli.ts');
const tsx = resolve('node_modules/.bin/tsx');
const cwd = mkdtempSync(join(tmpdir(), 'crispy-cli-'));
let apps: { url: string; close: () => Promise<void> }[] = [];

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

// Async on purpose: the fixture servers live in this process and must keep serving.
function exec(dir: string, args: string[]): Promise<Result> {
  return new Promise((done) => {
    execFile(tsx, [cli, ...args], { cwd: dir, timeout: 120_000 }, (err, stdout, stderr) => {
      done({ status: err ? Number(err.code ?? 1) : 0, stdout, stderr });
    });
  });
}
const crispy = (...args: string[]) => exec(cwd, args);

beforeAll(async () => {
  const dirs = await buildFixture();
  apps = [await serve(dirs.slow), await serve(dirs.fast)];
});
afterAll(async () => Promise.all(apps.map((a) => a.close())));

function writeConfig(file: string, baseUrl: string) {
  writeFileSync(
    join(cwd, file),
    JSON.stringify({
      baseUrl,
      runs: 1,
      settleMs: 150,
      scenarios: [
        {
          name: 'list',
          steps: [{ action: 'click', selector: '#inc' }],
          budgets: { interaction: { maxWastedRenders: 0 } },
        },
      ],
    }),
  );
}

describe('crispy CLI', () => {
  it('prints help and version', async () => {
    expect((await crispy('--help')).stdout).toContain('crispy run');
    expect((await crispy('--version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await crispy('bogus')).status).toBe(2);
  });

  it('init refuses to overwrite and writes a valid config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crispy-init-'));
    expect((await exec(dir, ['init', '--base-url', 'http://localhost:4000'])).status).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, 'crispy.config.json'), 'utf8'));
    expect(written.baseUrl).toBe('http://localhost:4000');
    // The starter only loads the page: no click that could log the user out.
    expect(written.scenarios[0].steps).toEqual([]);
    expect((await exec(dir, ['init'])).status).toBe(2);
  });

  it('runs scenarios, enforces budgets and compares reports', async () => {
    const [slow, fast] = apps as unknown as [{ url: string }, { url: string }];
    writeConfig('slow.json', slow.url);
    writeConfig('fast.json', fast.url);

    // Header re-renders wastefully in both variants -> budget of 0 is exceeded.
    const r1 = await crispy('run', '-c', 'slow.json', '-o', 'slow.report.json');
    expect(r1.status).toBe(1);
    expect(r1.stdout).toContain('Budget violations');
    expect(
      (await crispy('run', '-c', 'fast.json', '-o', 'fast.report.json', '--no-fail')).status,
    ).toBe(0);

    const better = await crispy(
      'compare',
      'slow.report.json',
      'fast.report.json',
      '--markdown',
      'cmp.md',
    );
    expect(better.status).toBe(0);
    expect(readFileSync(join(cwd, 'cmp.md'), 'utf8')).toContain('improved');

    const worse = await crispy('compare', 'fast.report.json', 'slow.report.json');
    expect(worse.status).toBe(1);
    expect(worse.stdout).toContain('regression');
  });

  it('fails cleanly on a missing config', async () => {
    const r = await crispy('run', '-c', 'nope.json');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Config file not found');
  });
});

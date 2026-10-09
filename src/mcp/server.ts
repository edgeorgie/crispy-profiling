import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, parseConfig, StepSchema } from '../config.js';
import { profile } from '../profiler/run.js';
import { localPackageName, servedPackageName } from '../profiler/webserver.js';
import { serializeReport } from '../report/aggregate.js';
import { compareReports } from '../report/compare.js';
import { compareToMarkdown, reportToMarkdown } from '../report/markdown.js';
import { scan } from '../scan.js';
import { runSnapshotTest } from '../snapshot-test.js';
import type { CrispyReport } from '../types.js';
import { cmp } from '../util/cmp.js';
import { VERSION } from '../version.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
/** The CLI wording of the shared Markdown, rewritten as the MCP calls an agent makes. */
const forAgents = (md: string) =>
  md
    .replace(
      /`crispy test (?:--update|-u)`/g,
      '`test_render_snapshots` with update=true (after the user approves, with confirm="accept-render-changes")',
    )
    .replace(/with `-u`/g, 'with update=true')
    .replace(/`crispy test`/g, '`test_render_snapshots`')
    .replace(/`crispy run`/g, '`profile_url`');

const fail = (err: unknown) => ({ ...text(`Error: ${(err as Error).message}`), isError: true });

async function readReport(path: string): Promise<CrispyReport> {
  const json = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (json?.schemaVersion !== 1) throw new Error(`${path} is not a crispy-profiling report`);
  return json as CrispyReport;
}

async function saveReport(report: CrispyReport, outFile?: string): Promise<string> {
  if (!outFile) return '';
  const abs = resolve(outFile);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, serializeReport(report));
  return `\n\nFull JSON report written to ${abs}`;
}

/**
 * Agents run the MCP server in their project: refuse a URL that serves another
 * app (Vite exposes its package.json), so numbers never come from the wrong app.
 */
async function assertThisApp(url: string): Promise<void> {
  const served = await servedPackageName(url);
  const local = localPackageName(process.cwd());
  if (served && local && served !== local) {
    throw new Error(
      `${new URL(url).origin} serves "${served}", not this project ("${local}"). Start this app's dev server (on its own port if another app uses this one) and pass its URL.`,
    );
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'crispy-profiling', version: VERSION });

  server.registerTool(
    'profile_url',
    {
      title: 'Profile React renders of a URL',
      description:
        'Opens a URL in headless Chromium, optionally runs interaction steps, and reports which React ' +
        'components rendered, how often, why (props/state/context/parent) and which renders were wasted. ' +
        'Render counts are deterministic: use this before and after a change to verify a performance fix.',
      inputSchema: {
        url: z.url().describe('Page to profile, e.g. http://localhost:5173/products'),
        steps: z
          .array(StepSchema)
          .default([])
          .describe(
            'Interactions to perform after load. Renders during them go to phase "interaction".',
          ),
        runs: z.number().int().min(1).max(10).default(1),
        top: z.number().int().min(1).max(100).default(15).describe('Components shown per phase'),
        outFile: z.string().optional().describe('Optional path to write the full JSON report'),
        timings: z
          .boolean()
          .default(false)
          .describe(
            'Also measure JavaScript ms per phase (varies between runs, unlike render counts): use it to tell the user how much faster an interaction got.',
          ),
      },
    },
    async ({ url, steps, runs, top, outFile, timings }) => {
      try {
        const u = new URL(url);
        await assertThisApp(url);
        const config = parseConfig({
          baseUrl: u.origin,
          runs,
          timings,
          scenarios: [{ name: 'page', path: `${u.pathname}${u.search}${u.hash}`, steps }],
        });
        const report = await profile(config);
        return text(reportToMarkdown(report, top) + (await saveReport(report, outFile)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'scan_app',
    {
      title: 'Find and profile interactions automatically',
      description:
        'Zero-config start: opens the app, finds safe interactions on a few routes (buttons, tabs, ' +
        'text inputs; never delete/pay/sign-out/submit), profiles each one and returns the top root ' +
        'causes of avoidable renders with fixes, plus the scenarios as crispy.config.json scenarios ' +
        'so they can be saved and guarded with test_render_snapshots.',
      inputSchema: {
        url: z.url().describe('Start page, e.g. http://localhost:5173/'),
        maxRoutes: z.number().int().min(1).max(10).default(2),
        maxActions: z.number().int().min(1).max(20).default(4).describe('Interactions per route'),
      },
    },
    async ({ url, maxRoutes, maxActions }) => {
      try {
        const u = new URL(url);
        await assertThisApp(url);
        const config = parseConfig({ baseUrl: u.origin, scenarios: [{ name: 'scan' }] });
        const result = await scan(config, {
          path: `${u.pathname}${u.search}`,
          maxRoutes,
          maxActions,
          // One run each keeps an exploratory scan fast; test_render_snapshots re-runs them.
          runs: 1,
        });
        const causes = result.causes.length
          ? result.causes
              .slice(0, 10)
              .map((c, i) => `${i + 1}. [${c.where}] ${c.text}`)
              .join('\n')
          : 'No avoidable renders found in these interactions.';
        const skipped = result.skipped.length
          ? `\n\nSkipped:\n${result.skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n')}`
          : '';
        const notTried = result.notTried.length
          ? `\n\nNot tried (so these flows are NOT covered):\n${result.notTried.map((n) => `- ${n}`).join('\n')}`
          : '';
        return text(
          `${result.scenarios.length} interaction(s) profiled (${result.scenarios.map((s) => s.name).join(', ')}).\n\nTop root causes:\n${causes}${skipped}${notTried}\n\n` +
            `Scenarios (save under "scenarios" in crispy.config.json):\n${JSON.stringify(result.scenarios)}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'run_scenarios',
    {
      title: 'Run crispy.config.json scenarios',
      description:
        'Runs the scenarios defined in a crispy.config.json (budgets included) and returns a summary. ' +
        'Write the report to a file to compare it later with compare_reports.',
      inputSchema: {
        configPath: z.string().default('crispy.config.json'),
        scenarios: z.array(z.string()).optional().describe('Only run these scenario names'),
        outFile: z.string().optional(),
        top: z.number().int().min(1).max(100).default(15),
      },
    },
    async ({ configPath, scenarios, outFile, top }) => {
      try {
        const config = await loadConfig(configPath);
        const report = await profile(config, {
          only: scenarios,
          cwd: dirname(resolve(configPath)),
        });
        return text(reportToMarkdown(report, top) + (await saveReport(report, outFile)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'test_render_snapshots',
    {
      title: 'Check render counts against the committed snapshot',
      description:
        'Runs the crispy.config.json scenarios and compares render counts with the committed ' +
        'snapshot (crispy.snap.json), like snapshot tests for re-renders. Regressions include the ' +
        'unstable prop, where the component is rendered and a suggested fix. Read-only by default: ' +
        'it never edits an existing snapshot. With no snapshot yet, update=true records the first one ' +
        '(it only stores the current counts). To accept changed counts later, the USER must approve; ' +
        'then pass update=true together with confirm="accept-render-changes".',
      inputSchema: {
        configPath: z.string().default('crispy.config.json'),
        update: z.boolean().default(false),
        confirm: z
          .string()
          .optional()
          .describe(
            'Must be "accept-render-changes" (after explicit user approval) when update=true',
          ),
        scenarios: z.array(z.string()).optional(),
      },
    },
    async ({ configPath, update, confirm, scenarios }) => {
      try {
        // Recording the first snapshot accepts nothing: it only stores today's counts.
        const first = async () => {
          const c = await loadConfig(configPath).catch(() => null);
          return !!c && !existsSync(resolve(dirname(resolve(configPath)), c.snapshot.file));
        };
        if (update && confirm !== 'accept-render-changes' && !(await first())) {
          throw new Error(
            'update=true changes the committed snapshot. Ask the user to approve the new counts, then pass confirm="accept-render-changes".',
          );
        }
        const config = await loadConfig(configPath);
        const outcome = await runSnapshotTest(config, {
          update,
          readOnly: true,
          only: scenarios,
          baseDir: dirname(resolve(configPath)),
        });
        return text(
          `Status: ${outcome.exitCode !== 0 ? 'FAIL' : outcome.result?.changes.some((c) => c.suspect) ? 'WARN (fewer renders on a component that reads mutable data: check the UI, or undo that React.memo)' : 'PASS'}\n\n${forAgents(outcome.markdown)}\nExit status: ${outcome.exitCode === 0 ? 'pass' : 'fail'}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'compare_reports',
    {
      title: 'Compare two crispy reports',
      description:
        'Diffs a baseline report against a new one and lists render regressions and improvements per component.',
      inputSchema: {
        basePath: z.string(),
        headPath: z.string(),
        rendersIncreasePct: z.number().min(0).default(10),
        minRendersDelta: z.number().int().min(0).default(1),
      },
    },
    async ({ basePath, headPath, rendersIncreasePct, minRendersDelta }) => {
      try {
        const result = compareReports(await readReport(basePath), await readReport(headPath), {
          rendersIncreasePct,
          minRendersDelta,
        });
        return text(compareToMarkdown(result));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'inspect_component',
    {
      title: 'Inspect one component in a report',
      description:
        'Returns the full per-phase stats for one component (render causes and changed prop keys), ' +
        'which tells you whether to reach for React.memo, useCallback/useMemo or state colocation.',
      inputSchema: { reportPath: z.string(), component: z.string() },
    },
    async ({ reportPath, component }) => {
      try {
        const report = await readReport(reportPath);
        const keys = new Set<string>();
        for (const s of Object.values(report.scenarios)) {
          for (const p of Object.values(s.phases))
            for (const k of Object.keys(p.components)) keys.add(k);
        }
        // Exact key first, then keys sharing the base name (`Item (src/a.tsx)`, `Item#2`).
        // `Item (src/a.tsx)`, `Item#2` and `styled.div @ src/Card.tsx:12` all match
        // `Item` / `styled.div`; case only matters when it disambiguates.
        const base = (k: string) =>
          k
            .replace(/ @ .*$/, '')
            .replace(/ \(.*\)$/, '')
            .replace(/#\d+$/, '');
        const byBase = (eq: (a: string, b: string) => boolean) =>
          [...keys].filter((k) => eq(base(k), base(component))).sort(cmp);
        const exact = byBase((a, b) => a === b);
        const wanted = keys.has(component)
          ? [component]
          : exact.length
            ? exact
            : byBase((a, b) => a.toLowerCase() === b.toLowerCase());
        const found: Record<string, unknown> = {};
        for (const s of Object.values(report.scenarios)) {
          for (const [phase, p] of Object.entries(s.phases)) {
            for (const k of wanted) {
              const c = p.components[k];
              if (c)
                found[wanted.length > 1 ? `${s.name}/${phase}/${k}` : `${s.name}/${phase}`] = c;
            }
          }
        }
        if (Object.keys(found).length === 0) {
          const needle = component.toLowerCase();
          const similar = [...keys].filter((k) => k.toLowerCase().includes(needle)).sort(cmp);
          throw new Error(
            `Component "${component}" not found.` +
              (similar.length ? ` Did you mean: ${similar.slice(0, 10).join(', ')}?` : ''),
          );
        }
        return text(JSON.stringify(found, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

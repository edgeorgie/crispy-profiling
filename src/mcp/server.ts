import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, parseConfig, StepSchema } from '../config.js';
import { profile } from '../profiler/run.js';
import { serializeReport } from '../report/aggregate.js';
import { compareReports } from '../report/compare.js';
import { compareToMarkdown, reportToMarkdown } from '../report/markdown.js';
import { runSnapshotTest } from '../snapshot-test.js';
import type { CrispyReport } from '../types.js';
import { VERSION } from '../version.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
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
      },
    },
    async ({ url, steps, runs, top, outFile }) => {
      try {
        const u = new URL(url);
        const config = parseConfig({
          baseUrl: u.origin,
          runs,
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
        const report = await profile(config, { only: scenarios });
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
        'it never creates or edits the snapshot. To accept new counts, the USER must approve; then ' +
        'pass update=true together with confirm="accept-render-changes".',
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
        if (update && confirm !== 'accept-render-changes') {
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
          `${outcome.markdown}\nExit status: ${outcome.exitCode === 0 ? 'pass' : 'fail'}`,
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
        const found: Record<string, unknown> = {};
        for (const s of Object.values(report.scenarios)) {
          for (const [phase, p] of Object.entries(s.phases)) {
            const c = p.components[component];
            if (c) found[`${s.name}/${phase}`] = c;
          }
        }
        if (Object.keys(found).length === 0) throw new Error(`Component "${component}" not found`);
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

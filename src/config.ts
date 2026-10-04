import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const StepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector: z.string().min(1) }),
  z.object({ action: z.literal('hover'), selector: z.string().min(1) }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({
    action: z.literal('type'),
    selector: z.string().min(1),
    value: z.string(),
    delayMs: z.number().int().min(0).max(1000).optional(),
  }),
  z.object({ action: z.literal('press'), key: z.string().min(1), selector: z.string().optional() }),
  z.object({ action: z.literal('waitFor'), selector: z.string().min(1) }),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(60_000) }),
  z.object({ action: z.literal('scroll'), y: z.number(), selector: z.string().optional() }),
  z.object({ action: z.literal('goto'), path: z.string().min(1) }),
  z.object({
    action: z.literal('phase'),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-_]*$/i, 'phase names must be alphanumeric (plus - and _)'),
  }),
]);
export type Step = z.infer<typeof StepSchema>;

export const ComponentBudgetSchema = z.object({
  maxRenders: z.number().int().min(0).optional(),
  maxWastedRenders: z.number().int().min(0).optional(),
  /** Wasted renders plus renders caused only by recreated-but-equal inputs. */
  maxAvoidableRenders: z.number().int().min(0).optional(),
});

export const BudgetSchema = z.object({
  maxCommits: z.number().int().min(0).optional(),
  maxTotalRenders: z.number().int().min(0).optional(),
  maxWastedRenders: z.number().int().min(0).optional(),
  /** Wasted renders plus renders caused only by recreated-but-equal inputs. */
  maxAvoidableRenders: z.number().int().min(0).optional(),
  components: z.record(z.string(), ComponentBudgetSchema).optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ScenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, 'scenario names must be alphanumeric'),
  path: z.string().default('/'),
  steps: z.array(StepSchema).default([]),
  /** Budgets keyed by phase name ("load", "interaction" or any custom phase). */
  budgets: z.record(z.string(), BudgetSchema).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const CompareOptionsSchema = z.object({
  /** A component regresses when renders grow by more than this percentage... */
  rendersIncreasePct: z.number().min(0).default(10),
  /** ...and by at least this absolute amount. */
  minRendersDelta: z.number().int().min(0).default(1),
});
export type CompareOptions = z.infer<typeof CompareOptionsSchema>;

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  baseUrl: z.url(),
  runs: z.number().int().min(1).max(20).default(3),
  viewport: z
    .object({ width: z.number().int().min(200), height: z.number().int().min(200) })
    .default({ width: 1280, height: 800 }),
  /** Time without React commits after which the page is considered settled. */
  settleMs: z.number().int().min(50).max(10_000).default(300),
  /** Hard limit for a single navigation / step / settle wait. */
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  /**
   * Max time to wait for a page to settle after a step. Apps that never stop
   * committing (polling, clocks, animations) produce a warning instead of hanging.
   */
  maxSettleMs: z.number().int().min(100).max(120_000).default(10_000),
  /**
   * Control timers with a fake clock (setTimeout, setInterval, requestAnimationFrame,
   * Date, performance). Makes apps with polling/animations deterministic.
   */
  clock: z.boolean().default(false),
  /**
   * Include wall-clock timings (component self time, LCP, CLS, long tasks).
   * Off by default because timings make reports non-reproducible.
   */
  timings: z.boolean().default(false),
  /** Number of components to keep per phase in the report (sorted by renders). 0 = all. */
  topComponents: z.number().int().min(0).default(0),
  compare: CompareOptionsSchema.default({ rendersIncreasePct: 10, minRendersDelta: 1 }),
  browser: z
    .object({
      executablePath: z.string().optional(),
      channel: z.string().optional(),
      headless: z.boolean().default(true),
    })
    .default({ headless: true }),
  scenarios: z.array(ScenarioSchema).min(1),
});
export type CrispyConfig = z.infer<typeof ConfigSchema>;
export type CrispyConfigInput = z.input<typeof ConfigSchema>;

/**
 * Phases a scenario can produce: "load", then "interaction" when steps start
 * without an explicit phase, then every `phase` step name.
 */
export function phasesOf(scenario: Scenario): string[] {
  const phases = ['load'];
  if (scenario.steps.length > 0 && scenario.steps[0]?.action !== 'phase')
    phases.push('interaction');
  for (const step of scenario.steps) {
    if (step.action === 'phase' && !phases.includes(step.name)) phases.push(step.name);
  }
  return phases;
}

export function parseConfig(input: unknown): CrispyConfig {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid crispy config:\n${z.prettifyError(result.error)}`);
  }
  const names = new Set<string>();
  for (const s of result.data.scenarios) {
    if (names.has(s.name)) throw new Error(`Invalid crispy config: duplicate scenario "${s.name}"`);
    names.add(s.name);
    const phases = phasesOf(s);
    for (const phase of Object.keys(s.budgets ?? {})) {
      if (!phases.includes(phase)) {
        throw new Error(
          `Invalid crispy config: scenario "${s.name}" has a budget for unknown phase "${phase}". ` +
            `Known phases: ${phases.join(', ')}.`,
        );
      }
    }
  }
  return result.data;
}

export const DEFAULT_CONFIG_FILE = 'crispy.config.json';

export async function loadConfig(path = DEFAULT_CONFIG_FILE): Promise<CrispyConfig> {
  const abs = resolve(path);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    throw new Error(`Config file not found: ${abs}. Run "crispy init" to create one.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${abs}\n${(err as Error).message}`);
  }
  return parseConfig(json);
}

export function exampleConfig(baseUrl = 'http://localhost:5173'): CrispyConfigInput {
  return {
    $schema: './node_modules/crispy-profiling/schema/crispy.config.schema.json',
    baseUrl,
    runs: 3,
    scenarios: [
      {
        name: 'home',
        path: '/',
        steps: [
          { action: 'phase', name: 'interaction' },
          { action: 'click', selector: 'button' },
        ],
        budgets: { interaction: { maxAvoidableRenders: 50 } },
      },
    ],
  };
}

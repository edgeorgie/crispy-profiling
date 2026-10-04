# Product research plan: becoming the default answer for React re-render problems

**Goal:** when anyone — beginner or expert, human or AI agent — thinks *"my React app re-renders too
much"* or *"did my performance fix actually work?"*, the answer is crispy-profiling.

This plan defines **what we must learn**, **how we learn it**, **what "good" looks like** and **what
we do with each answer**. Every research question ends in a decision, not a document.

## 0. Principles

1. **Evidence over opinion.** Every decision cites data: measurements, interviews, benchmarks.
2. **Find → explain → fix → verify.** The product (and this process) never stops at "here is a
   problem". Every finding carries a proposed fix and a way to verify it.
3. **Red team every milestone.** A separate critic agent, in a fresh context, attacks each milestone
   with argued, evidence-based criticism. We answer every finding with a fix plan or an explicit
   "won't fix, because…". See §5.
4. **Friction is a bug.** Time-to-first-insight is a tracked metric, like a failing test.
5. **Complement, don't clone.** Where a competitor is excellent (e.g. static linting), integrate
   instead of rebuilding.

## 1. Category and positioning hypotheses (to validate)

| ID | Hypothesis | Validated by |
| --- | --- | --- |
| H1 | Re-render problems still cost real time in 2026, even with React Compiler | RQ1 |
| H2 | Teams and agents lack a *runtime proof* that a change improved (or did not regress) rendering | RQ1, RQ6 |
| H3 | Deterministic counts + causes + fix suggestions let agents fix render bugs more often and faster | RQ6 |
| H4 | A one-command, zero-config experience is required for adoption | RQ5 |
| H5 | Positioning as "runtime verification" next to static linters (React Doctor) is credible and distinct | RQ4, RQ9 |

Working positioning statement (to test in RQ9):
> **Static linters tell you what *might* be wrong. crispy-profiling shows what *actually* happens at
> runtime, tells you how to fix it, and proves the fix worked.**

## 2. Audiences

| Persona | Job to be done | What "great" looks like |
| --- | --- | --- |
| **Beginner** React dev | "Why is my app slow / why does this re-render?" | One command, plain-language explanation, copy-paste fix |
| **Senior / perf-minded dev** | "Find the expensive re-render paths and prove my fix" | Accurate causes, cost data, before/after diff |
| **Team lead / CI owner** | "Stop render regressions from merging" | Budgets, PR comment, low noise, no flakiness |
| **AI coding agent** | "Verify my change didn't add renders; fix the one the user asked about" | Small structured output, exact location, suggested fix, verification command |
| **Library author** | "Does my component cause re-renders in consumers?" | Scenario on a demo app, regression guard in CI |
| **Teams adopting React Compiler** | "Did the compiler help? What did it not fix?" | Compiled vs not-compiled components, remaining wasted renders |
| React Native / Expo dev | Same pains on mobile | (Out of scope for v1 — validate demand in RQ1) |

## 3. Research questions

Each RQ: method → sample → success criterion → decision it drives. Timeboxes assume one maintainer
plus agents.

### RQ1 — Is the problem real and frequent in the React Compiler era? (3 days)

- **Methods**
  1. Mine GitHub issues/discussions of 30 popular React apps and libraries for "re-render",
     "unnecessary render", "useMemo", "useCallback", "React.memo", "INP" (last 12 months); classify
     by root cause.
  2. Profile 10 open source React apps (mix: Vite SPA, Next.js, dashboards, editors) with crispy,
     with and without React Compiler where possible; record wasted renders per interaction.
  3. Short survey (React communities, Reddit r/reactjs, Discord, LinkedIn): frequency, cost, tools used.
  4. 8–10 interviews across personas (§2).
- **Success:** ≥ 50% of profiled apps show at least one interaction with fixable wasted renders
  that matter (> 50 wasted renders or measurable INP impact); ≥ 30% of survey respondents hit
  the problem monthly.
- **Decision:** go / pivot. A pivot candidate is "React Compiler verification" or "INP root-cause".

### RQ2 — Which metric matters: render count, render cost or user-facing latency? (2 days)

- **Methods:** on the 10 apps, correlate wasted renders and `selfDurationMs` with INP/long tasks per
  interaction; find cases where counts mislead (many cheap renders vs few expensive ones).
- **Success:** a ranking formula (e.g. renders × self time, weighted by interaction) that matches
  expert judgment in ≥ 8/10 cases.
- **Decision:** what the report sorts by and what budgets default to.

### RQ3 — When and how do people look for a solution? (1 day)

- **Methods:** search-term analysis ("why did this component re-render", "react re-render
  debugging", "react compiler not memoizing"), StackOverflow tags, which tools appear in answers;
  what agents answer today when asked.
- **Success:** list of the top 20 queries and the current "winning" answer for each.
- **Decision:** docs titles, README wording, examples, the skill's `description` (agents trigger on it).

### RQ4 — Competitive teardown (2 days)

- **Methods:** install and use each competitor on the same 3 apps: React Doctor (static + `scan`),
  React Scan, react-render-profile-mcp, Chrome DevTools MCP, why-did-you-render, Reassure. Score:
  steps to first insight, time to first insight, accuracy of the cause, actionability (does it say
  what to change and where), CI support, agent support, noise.
- **Success:** a scored matrix with reproducible notes.
- **Decision:** which features to match, which to skip, which to integrate with.

### RQ5 — Friction: time-to-first-insight (ongoing, measured every release)

- **Methods:** scripted "zero to first useful result" runs for each persona on a clean machine
  (devcontainer + macOS + Windows). Count commands, prompts, downloads, files to write.
- **Targets:** beginner ≤ 1 command and ≤ 60 s (excluding app start); agent ≤ 1 tool call; CI ≤ 5
  lines of YAML. No config file needed for the first result.
- **Decision:** priority of zero-config mode, system-Chrome detection, dev-server auto-start,
  `setup` command for agents, `record` mode.

### RQ6 — Does crispy make AI agents better at fixing render problems? (4 days)

The strongest evidence for "AI-friendly" is a benchmark.

- **Methods**
  1. Build **crispy-bench**: 15–20 small React apps, each with a known re-render bug (unstable
     callback, inline object, broad context, state too high, list keys, effect loops, compiler
     bail-outs…) and a hidden "correct fix" check.
  2. Run agents (Claude Code, Codex, Cursor, Copilot) on each task **with** and **without** crispy
     (MCP + skill). Measure: success rate, regressions introduced, tool calls, tokens, time.
- **Success:** ≥ 25 percentage points higher success rate, or ≥ 30% fewer iterations, with crispy.
- **Decision:** MCP tool design (granularity, output size), skill content; publish the benchmark
  (a public benchmark helps own the category).

### RQ7 — Actionability: can we tell users exactly what to change, and where? (3 days)

- **Methods**
  1. Feasibility of source locations: React 19 owner stacks / `_debugStack`, source maps,
     component display names + file search.
  2. Map each cause signature to a fix template (see §4) and measure suggestion accuracy on crispy-bench.
  3. Evaluate "suggest" vs "auto-apply" (codemod) — trust and safety trade-offs.
- **Success:** ≥ 80% of suggestions on crispy-bench are the correct fix category; file location
  found for ≥ 70% of components in dev builds.
- **Decision:** v0.2 output format; whether to ship codemods.

### RQ8 — Technical robustness matrix (3 days)

- **Matrix:** React 17 / 18 / 19 × React Compiler on/off × Vite / Next.js (pages + app router,
  hydration) / Remix × StrictMode × Suspense/transitions × portals × multiple roots × large trees
  (10k+ fibers) × apps behind login.
- **Success:** documented support table; no crash; overhead < 2× on large trees.
- **Decision:** supported-platform claims in the README; known-limitations section.

### RQ9 — Distribution and becoming the default answer (2 days + ongoing)

- **Methods:** test the positioning statement in interviews (RQ1) and on 2–3 landing-copy
  variants; map where each persona discovers tools (skills.sh, MCP Registry, Anthropic directory,
  React newsletters, conference talks, awesome lists); evaluate integration/partnership with React
  Doctor (recommend each other: static → runtime).
- **Success:** a channel plan with owners and dates; ≥ 1 integration conversation started.
- **Decision:** launch plan and messaging.

### RQ10 — Name and trust (0.5 day)

- **Questions:** repository typo (`crispy-profilling`) vs package (`crispy-profiling`); is
  "crispy" memorable and searchable; trust signals (provenance, Scorecard, real case studies).
- **Decision:** rename before the first public release or not.

## 4. Actionability by design: "find → explain → fix → verify"

**Current state:** partially covered. The Agent Skill maps signals to fixes (e.g. "changed prop is a
function → `useCallback` + `React.memo`"), but the CLI/MCP **output itself does not include fix
suggestions** yet. Planned output for every finding:

| Field | Example |
| --- | --- |
| `finding` | `Row` re-rendered 20× in `interaction`, 20 caused by prop `onSelect` |
| `evidence` | `changedProps: { onSelect: 20 }`, parent `App` re-rendered on `count` state |
| `suggestedFix` | Wrap `onSelect` in `useCallback` in `App`; wrap `Row` in `React.memo` |
| `location` | `src/App.tsx:42` (when source info is available) |
| `verify` | `crispy compare base.json head.json` → expect `Row` 20 → 0 in `interaction` |
| `confidence` | high / medium / low, with the reason |

Fix templates to research and implement (RQ7):

| Signature | Suggested fix |
| --- | --- |
| Wasted (cause `parent`), component cheap | Usually ignore; only memoize if hot path |
| Wasted, component expensive | `React.memo`, or move state down / lift content up (children as props) |
| Changed prop is a function | `useCallback` in the owner (+ `React.memo` on child), or React Compiler |
| Changed prop is an object/array literal | `useMemo` / hoist constant / pass primitives |
| Cause `context` on many consumers | Split context, memoize provider `value`, selector pattern / external store |
| Cause `state` at high frequency | Colocate state, `useDeferredValue`, debounce |
| Component not compiled by React Compiler | Show the bail-out reason (compiler diagnostics) |

## 5. Red-team loop (process)

At every milestone (end of each RQ batch, before each release):

1. **Critique:** spawn a critic agent in a fresh context with only the repository and this plan.
   It must produce findings with severity, evidence (file:line, command output or URL) and why it
   matters — no fixes.
2. **Respond:** for every finding, write a fix plan (what, where, effort, owner) or "won't fix" with
   a reason. Track them in `docs/research/critique-log.md` and as GitHub issues.
3. **Fix** in atomic `feature/*` or `bugfix/*` PRs.
4. **Re-critique** the fixed areas in a new fresh context. A finding is closed only when the critic
   can no longer reproduce it.

## 6. Timeline and go / no-go

| Week | Work | Exit criterion |
| --- | --- | --- |
| 1 | RQ1, RQ3, RQ4, RQ10 | Problem validated or pivot chosen |
| 2 | RQ2, RQ5 (zero-config, setup), RQ7 prototype | Time-to-first-insight ≤ 60 s; fix suggestions in output |
| 3 | RQ6 (crispy-bench), RQ8 | Agent benchmark results; support matrix |
| 4 | RQ9, red-team round, release 0.1.0 | Launch plan; all critical/high findings closed |

**No-go signals:** RQ1 fails (problem not frequent), RQ6 shows no agent improvement, or a competitor
covers runtime verification + fixes + CI with equal friction. In that case, pivot to the strongest
validated niche (e.g. React Compiler verification) or contribute the ideas upstream.

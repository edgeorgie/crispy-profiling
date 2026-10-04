# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI, …) and humans
working on this repository. `CLAUDE.md` and `.github/copilot-instructions.md` point here.

## Project in one paragraph

crispy-profiling is a **proof of concept** for deterministic React render profiling. It opens a
React app in headless Chromium (playwright-core), records every component render through
`__REACT_DEVTOOLS_GLOBAL_HOOK__`, classifies why each render happened (props / state / context /
parent) and produces reproducible JSON reports that can be budgeted and compared. It ships as a CLI,
an MCP server, an Agent Skill, a Claude Code plugin and a GitHub Action.

**Current priority:** prove the tool is useful on real React apps. Prefer working functionality and
real-world validation over test coverage, polish or new abstractions.

## Setup and commands

```bash
npm ci
npx tsx src/cli.ts install     # Chromium matching our playwright-core
npm run check                  # lint + typecheck + tests + build
npx tsx src/cli.ts --help      # run the CLI from source
```

If Chromium cannot be downloaded, set `CRISPY_CHROMIUM_PATH` to any Chromium/Chrome binary.

## Map of the code

| Path | Responsibility |
| --- | --- |
| `src/profiler/hook.ts` | Code injected in the page. **Must stay self-contained** (serialized with `toString`). |
| `src/profiler/run.ts` | Browser orchestration: scenarios, steps, phases, settling. |
| `src/report/` | Aggregation + budgets, comparison, Markdown output. |
| `src/config.ts` | `crispy.config.json` schema (zod). Regenerate `schema/` with `npm run schema`. |
| `src/cli.ts`, `src/mcp/server.ts` | User-facing entry points. |
| `skills/react-render-profiling/SKILL.md` | Agent Skill shipped to users. |
| `.claude-plugin/`, `server.json` | Claude Code plugin/marketplace and MCP Registry manifests. |
| `test/fixtures/app/App.tsx` | React app (naive + optimized variants) used by e2e tests. |

## Rules

1. **English only** — code, comments, docs, commit messages, PRs and issues.
2. **Determinism** — reports must be byte-for-byte reproducible. Sort with `cmp` from
   `src/util/cmp.ts` (never `localeCompare`), no timestamps, wall-clock data only behind `timings`.
3. **Keep runtime dependencies minimal** (MCP SDK, playwright-core, zod).
4. **Versions** — `package.json`, `.claude-plugin/plugin.json` and `server.json` must match
   (`npm version` runs `scripts/sync-version.ts`).
5. Update the README and the skill when user-facing behavior changes.

## Git workflow (GitFlow)

- `main` = released code only. `develop` = integration branch (default branch).
- Branch names: `feature/<short-kebab-name>`, `bugfix/<name>`, `release/<x.y.z>`, `hotfix/<x.y.z>`,
  `docs/<name>`. Never use tool-generated branch names.
- `feature/*`, `bugfix/*`, `docs/*` branch from `develop` and merge back into `develop` via PR.
- `release/*` branches from `develop`, merges into `main` via PR, then `main` is tagged `vX.Y.Z`
  and merged back into `develop`. `hotfix/*` branches from `main` and merges into both.
- Group related changes into one well-organized PR per milestone (atomic commits inside the branch)
  instead of many tiny PRs, and **squash-merge** it.

## Commits and pull requests

- **Atomic commits**: one logical change per commit; the project should build after each one.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `build`, `ci`, `chore`, with an optional scope, e.g. `feat(cli): add install command`.
- Imperative mood, subject ≤ 72 characters, body explains *why* when not obvious.
- **Do not add `Co-authored-by` trailers or any AI-attribution lines** to commits or PRs.
- One concern per PR, with a description of what, why and how it was verified.

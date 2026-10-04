# Roadmap

crispy-profiling is a **proof of concept**. The roadmap is ordered so that we learn whether the tool
is worth it *before* investing in polish, distribution and growth. Each step has an owner, an exact
action and a verifiable "done" criterion.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Product | Deterministic React re-render profiling for agents and CI | See [research/distribution-channels.md](research/distribution-channels.md) §1 |
| npm name | `crispy-profiling` (free on npm as of 2026-10-04) | Matches the repository |
| Stack | TypeScript 5, ESM, Node ≥ 20, playwright-core, zod, MCP SDK | JS-first ecosystem for MCP and skills |
| Instrumentation | `__REACT_DEVTOOLS_GLOBAL_HOOK__` + fiber diffing | No changes to the profiled app |
| Tooling | tsup · Vitest · Biome | Fast, near-zero config |
| Git | GitFlow, Conventional Commits, merge commits | See [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Language | English everywhere | Global audience |
| License | MIT | Maximum adoption |

## Phase 0 — Foundations ✅

Profiler, CLI, MCP server, Agent Skill, Claude Code plugin, MCP Registry manifest, GitHub Action,
CI/release workflows, community and AI-agent files.

## Phase 1 — Prove it works on real apps (current)

Goal: answer "does it find real, fixable re-render problems that people care about?"

| # | Action | Done when |
| --- | --- | --- |
| 1.1 | Profile 3 public React apps of different shapes (e.g. a Vite SPA, a Next.js app in dev mode, a large OSS dashboard) | Reports committed under `examples/case-studies/` |
| 1.2 | For each app, fix the top finding in a fork and re-profile | Before/after comparison shows a real reduction |
| 1.3 | Run it through an AI agent end-to-end (MCP + skill) on one of those apps | The agent proposes and verifies a fix using only crispy's output |
| 1.4 | Profile one real work project (React at scale) | Written notes: useful findings, false positives, missing signals |
| 1.5 | Go / no-go review | Decide: continue, pivot (e.g. different signal) or stop |

Known gaps to watch during Phase 1: apps behind login, Next.js/RSC hydration, React 17/18
behavior, very large trees (performance of the hook), production builds with minified names.

## Phase 2 — First public release (only after a "go")

| # | Action | Owner | Done when |
| --- | --- | --- | --- |
| 2.1 | Set `develop` as the default branch, protect `main` and `develop` | Maintainer | Settings saved |
| 2.2 | Enable Discussions and private vulnerability reporting | Maintainer | Links in templates work |
| 2.3 | npm account + `NPM_TOKEN` secret (later: npm Trusted Publishing) | Maintainer | Secret listed |
| 2.4 | `release/0.1.0` → `main`, tag `v0.1.0` | Maintainer / agent | Release workflow green; `npm view crispy-profiling` shows 0.1.0 |
| 2.5 | Publish the Action to GitHub Marketplace | Maintainer | Listed |

## Phase 3 — Distribution

| # | Channel | Action | Done when |
| --- | --- | --- | --- |
| 3.1 | Official MCP Registry | Automatic in the release workflow | Server appears in registry search |
| 3.2 | skills.sh | First `npx skills add edgeorgie/crispy-profilling` indexes it | Skill page exists |
| 3.3 | Anthropic plugin directory | `claude plugin validate . --strict`, submit at claude.ai/directory/manage | Published |
| 3.4 | Glama, mcp.so, Smithery | Submit / claim listing | Listed |
| 3.5 | Awesome lists (MCP servers, Claude Code, React performance) | One PR each | PRs opened |

## Phase 4 — Product iterations (driven by Phase 1 findings)

Candidates, to be re-prioritized with real feedback:

- `crispy pr-comment` to post comparisons on pull requests.
- "Who triggered this commit?" — attribute each commit to the component whose update started it.
- Attach to an existing Chrome via CDP (apps behind login).
- `crispy record`: generate steps from Playwright codegen.
- Test matrix for React 17/18.
- `crispy.config.ts` support.

## Phase 5 — Community

- Launch post with a real before/after case study from Phase 1.
- Label 5 issues `good first issue` from Phase 4 candidates.
- Respond to new issues within 48 h.

# Research: making an open source project developer- and AI-friendly

Snapshot: October 2026. Each practice lists where this repository implements it.

## 1. Developer-friendly

| Practice | Why it matters | In this repo |
| --- | --- | --- |
| README that answers *what, why, how* in the first screen, with a copy-paste quick start | First impression decides adoption | `README.md` |
| Clear license (OSI-approved) | Companies can't use unlicensed code | `LICENSE` (MIT) |
| `CONTRIBUTING.md` with setup, workflow and conventions | Lowers the cost of the first PR | `CONTRIBUTING.md` |
| Code of conduct + security policy | GitHub community profile; safe reporting | `CODE_OF_CONDUCT.md`, `SECURITY.md` |
| Issue forms and PR template | Better reports, faster triage | `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md` |
| One-command reproducible environment | "Works on my machine" disappears | `.devcontainer/` (Codespaces), `.nvmrc`, `npm run check` |
| CI on every PR with the same commands contributors run | Trust in contributions | `.github/workflows/ci.yml` |
| Automated dependency updates | Fewer stale/vulnerable deps | `.github/dependabot.yml` |
| Supply-chain signals (OpenSSF Scorecard, npm provenance) | Enterprise adoption checks these | `scorecard.yml`, `release.yml` |
| Predictable releases: SemVer, changelog, generated release notes | Users know what changed | `CHANGELOG.md`, `.github/release.yml` |
| Consistent Git workflow and commit convention | Readable history, automatable releases | GitFlow + Conventional Commits |
| `good first issue` / `help wanted` labels with well-scoped issues | Primary entry point for new contributors | To do in Roadmap phase 5 |
| Typed public API and JSON Schema for config | Editor autocompletion, fewer support questions | `dist/index.d.ts`, `schema/` |
| Citation metadata | Academic/industry references | `CITATION.cff` |

Sources: [GitHub contribution docs](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-settings-on-your-profile/why-are-my-contributions-not-showing-up-on-my-profile),
[OpenSSF Scorecard](https://github.com/ossf/scorecard),
[community health files example](https://github.com/verbatra/skills/pull/7),
[GitFlow](https://nvie.com/posts/a-successful-git-branching-model/).

## 2. AI-friendly

Two different audiences: agents that **contribute** to the repo, and agents that **use** the
project in someone else's code.

### 2.1 Agents contributing to this repo

| Practice | Why | In this repo |
| --- | --- | --- |
| `AGENTS.md` at the root: setup commands, code map, rules, workflow | Cross-tool standard read by Claude Code, Codex, Cursor, Copilot, Gemini CLI, Aider, … | `AGENTS.md` |
| Thin tool-specific files that point to `AGENTS.md` | One source of truth, no drift | `CLAUDE.md` (`@AGENTS.md` import), `.github/copilot-instructions.md` |
| Deterministic, fast verification command | Agents need a reliable "am I done?" signal | `npm run check` |
| Explicit invariants written as rules, not tribal knowledge | Agents follow written rules | "Rules" section of `AGENTS.md` |
| Small, single-purpose modules with descriptive names | Fits in context, easy to locate | `src/profiler`, `src/report`, … |

### 2.2 Agents using this project

| Practice | Why | In this repo |
| --- | --- | --- |
| `llms.txt` index of the docs | Lets agents fetch the right page instead of guessing | `llms.txt` |
| MCP server | Tools callable from any MCP client | `crispy mcp`, `server.json` |
| Agent Skill (`SKILL.md`) | Teaches the *workflow* and how to interpret output | `skills/react-render-profiling/` |
| Machine-readable output (stable JSON + JSON Schema) and exit codes | Agents parse instead of scraping text | Reports, `schema/`, exit codes 0/1/2 |
| Copy-paste examples close to real usage | Models imitate examples | `examples/` |
| Listing in agent marketplaces | Discoverability | See [distribution-channels.md](distribution-channels.md) |
| Indexability by doc tools (DeepWiki, Context7) | Agents with doc tools get current docs | Public repo + clear README; submit when released |

Sources: [AGENTS.md / CLAUDE.md / Copilot guide](https://www.deployhq.com/blog/ai-coding-config-files-guide),
[agent context files explained](https://promptless.ai/blog/technical/agent-context-files-explained/),
[llms.txt vs AGENTS.md](https://www.quattr.com/blog/llms-txt-vs-agents-md),
[copilot-instructions.md guide](https://thepromptshelf.dev/blog/github-copilot-instructions-md-complete-guide-2026/),
[documentation stack for AI agents](https://ravichaganti.com/blog/documentation-stack-for-ai-agents/),
[agentskills.io](https://agentskills.io).

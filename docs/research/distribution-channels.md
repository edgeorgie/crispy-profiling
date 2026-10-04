# Research: project idea and AI agent / skill marketplaces

Snapshot: October 2026. Marketplace numbers change fast and are given as orders of magnitude.

## 1. Ideas evaluated

Scores 1–5: **Demand** (real, frequent pain), **Gap** (little direct competition), **Fit**
(React/TypeScript at scale), **Distribution** (how many channels accept it natively), **Effort**
(5 = MVP in days).

| # | Idea | Demand | Gap | Fit | Distribution | Effort | Total |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **A** | **crispy-profiling**: deterministic React re-render profiling for agents + CI | 5 | 4 | 5 | 5 | 4 | **23** |
| B | Linter / security scanner for `SKILL.md` and plugins | 4 | 1 | 3 | 4 | 5 | 17 |
| C | Generic web-performance MCP (Lighthouse / Web Vitals) | 4 | 1 | 4 | 4 | 4 | 17 |
| D | React/TS best-practice skill pack in Spanish/Portuguese | 3 | 3 | 5 | 4 | 5 | 20 |
| E | Agent-oriented accessibility regression (axe) | 4 | 2 | 4 | 4 | 4 | 18 |

**Why A**

- **Competition:** [React Scan](https://github.com/aidenybai/react-scan) is visual and interactive;
  [Reassure](https://oss.callstack.com/reassure/docs/introduction) measures components in jsdom
  through Testing Library (not real flows); [Meticulous' render check](https://app.meticulous.ai/docs/built-in-checks/react-component-renders)
  is commercial; [Chrome DevTools MCP](https://www.f22labs.com/blogs/chrome-devtools-mcp-how-ai-agents-debug-the-browser-natively/)
  and [lighthouse-mcp-server](https://github.com/danielsogl/lighthouse-mcp-server) give traces and
  Web Vitals but not the per-component *why*. No tool combines deterministic counts, causes, changed
  props, budgets and baseline diffs in one package designed for agents.
- **Determinism:** agents need a signal that is not noise. Render counts don't depend on the
  machine; timings do, so timings are opt-in.
- **One codebase, five channels:** npm, MCP Registry, Agent Skills, Claude Code plugins and GitHub
  Marketplace.

**Discarded:** B is saturated ([skill-check](https://github.com/thedaviddias/skill-check),
[Skillmark Lint](https://github.com/marketplace/actions/skillmark-lint),
[skills-lint](https://github.com/marketplace/actions/skills-lint-skill-md-linter),
[skillmd](https://github.com/skillmds/skillmd), …); C is covered by Chrome DevTools MCP and several
Lighthouse servers; D is a good *second* skill for this repo later; E largely exists with axe-core
+ Playwright.

## 2. Channels

### 2.1 Agent Skills (`SKILL.md`, open standard)

`SKILL.md` is an open standard ([agentskills.io](https://agentskills.io)); about 40 tools support it
(Claude, Codex, Copilot, VS Code, Cursor, Gemini CLI, Goose, OpenCode, …), per the
[2026 ecosystem report](https://agentman.ai/blog/agent-skills-ecosystem-report-2026).

| Directory | How to get listed | Effort | Value |
| --- | --- | --- | --- |
| [skills.sh](https://skills.sh/docs) (Vercel) | Automatic after the first `npx skills add <owner>/<repo>`; ranked by install telemetry ([FAQ](https://skills.sh/docs/faq)) | None | High |
| SkillsMP, SkillHub, claudemarket.ai, aitmpl.com | Crawl GitHub | None | Medium |
| Awesome lists | Pull request | Low | Medium |

### 2.2 MCP servers

A canonical **registry** plus **marketplaces** on top of it
([2026 comparison](https://designrevision.com/blog/best-mcp-marketplaces-and-registries)):

| Destination | How | Effort | Value |
| --- | --- | --- | --- |
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | `server.json` + `mcpName` + `mcp-publisher publish` with GitHub OIDC (automated in `release.yml`) | Done | Very high: feeds VS Code/GitHub, PulseMCP and others |
| [Glama](https://glama.ai/mcp/servers) (~21k servers) | Crawls GitHub; claim the listing | Low | High |
| [mcp.so](https://mcp.so) (~20k) | Submission form | Low | Medium |
| [Smithery](https://smithery.ai) (~7–8k) | Publish from their site | Low | Medium |
| [PulseMCP](https://www.pulsemcp.com) | Reads the official registry | None | Medium |
| Docker MCP Catalog | PR to `docker/mcp-registry` | Medium | Low here (needs a browser in the image) |

### 2.3 Claude Code plugins

| Destination | How | Effort | Value |
| --- | --- | --- | --- |
| Own marketplace (this repo) | `.claude-plugin/marketplace.json`; users run `/plugin marketplace add edgeorgie/crispy-profilling` | Done | High |
| [Anthropic directory](https://claude.ai/directory) | Developer portal at claude.ai/directory/manage; paid claude.ai plan; manual review ([docs](https://code.claude.com/docs/en/plugins/publish)) | Low | Very high: claude.ai, Cowork and Claude Code |
| [claudemarketplaces.com](https://claudemarketplaces.com) | Indexes repos with `marketplace.json` | None | Medium |

### 2.4 Other

| Destination | How | Value |
| --- | --- | --- |
| npm | Release workflow with provenance | Foundation for everything else |
| GitHub Marketplace (Actions) | `action.yml` at the root; tick "Publish to Marketplace" on a release | High for CI |

## 3. Conclusion

Four active publications (npm, MCP Registry, Anthropic directory, GitHub Marketplace) cascade into
the rest (skills.sh, Glama, PulseMCP, VS Code, claudemarketplaces). Everything that does not need
the maintainer's identity is automated in this repository.

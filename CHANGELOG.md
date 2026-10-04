# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

### Added
- Browser hook that records renders, mounts, updates, wasted renders, render causes
  (props/state/context/parent) and changed prop keys per component and phase.
- Scenario runner on Playwright (Chromium) with declarative steps and phases.
- Deterministic JSON reports (median/min/max over runs, stability flag); opt-in timings.
- Render budgets and baseline comparison with regression thresholds.
- CLI: `init`, `install`, `run`, `compare`, `mcp`.
- MCP server: `profile_url`, `run_scenarios`, `compare_reports`, `inspect_component`.
- Agent Skill `react-render-profiling`, Claude Code plugin + marketplace, MCP Registry manifest.
- Composite GitHub Action.

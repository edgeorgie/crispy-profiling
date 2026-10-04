# Contributing

Thanks for helping make React re-renders less mysterious! 🥓
This project is an early **proof of concept**: the most valuable contributions right now are
trying it on real React apps and reporting what it found (or missed).

## Ways to contribute

- **Try it** on your app and open an issue with the report and what you changed.
- **Report bugs** with the bug template (a minimal component + `crispy.config.json` is ideal).
- **Pick an issue** labeled [`good first issue`](https://github.com/edgeorgie/crispy-profiling/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/edgeorgie/crispy-profiling/labels/help%20wanted).
- **Improve docs** — typos and unclear explanations count.

## Development setup

Use the dev container (GitHub Codespaces / VS Code "Reopen in Container"), or locally with Node 20+:

```bash
git clone https://github.com/edgeorgie/crispy-profiling.git
cd crispy-profiling
git checkout develop
npm ci
npx tsx src/cli.ts install   # Chromium matching our playwright-core
npm run check                # lint + typecheck + tests + build
```

Project layout and conventions are documented in [AGENTS.md](AGENTS.md) (it is written for both
humans and AI coding agents).

## Git workflow

We use [GitFlow](https://nvie.com/posts/a-successful-git-branching-model/):

| Branch | From | Merges into | Purpose |
| --- | --- | --- | --- |
| `main` | — | — | Released code. Every merge is tagged `vX.Y.Z`. |
| `develop` | `main` | — | Integration branch (default). |
| `feature/<name>` | `develop` | `develop` | New functionality. |
| `bugfix/<name>` | `develop` | `develop` | Non-urgent fixes. |
| `docs/<name>` | `develop` | `develop` | Documentation only. |
| `release/<x.y.z>` | `develop` | `main` + `develop` | Version bump and release prep. |
| `hotfix/<x.y.z>` | `main` | `main` + `develop` | Urgent fixes to a release. |

1. Branch from `develop`: `git checkout -b feature/my-change develop`.
2. Make **atomic commits** using [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat(cli): add --json flag`, `fix(report): sort phases deterministically`, …).
3. Run `npm run check`, push and open a PR against `develop`. Fill in the template.
4. Keep one concern per PR (a milestone can group related commits). `feature/*`, `bugfix/*` and
   `docs/*` PRs are **squash-merged**; `release/*` and `hotfix/*` PRs, and merging `main` back into
   `develop`, use a **merge commit** so `main` and `develop` keep a shared history.

## Releasing (maintainers)

```bash
git checkout -b release/0.2.0 develop
npm version 0.2.0 --no-git-tag-version   # also syncs plugin.json and server.json
git commit -am "chore(release): 0.2.0"
# open PR release/0.2.0 -> main, merge it, then:
git checkout main && git pull && git tag v0.2.0 && git push origin v0.2.0
git checkout develop && git merge --no-ff main && git push
```

The tag triggers the Release workflow: npm (with provenance), MCP Registry and GitHub release.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

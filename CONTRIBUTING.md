# Contributing

Thanks for helping make React re-renders less mysterious! 🥓
This project is an early **proof of concept**: the most valuable contributions right now are
trying it on real React apps and reporting what it found (or missed).

## Ways to contribute

- **Try it** on your app and open an
  ["I tried it on my app"](https://github.com/edgeorgie/crispy-profiling/issues/new?template=tried_it.yml)
  issue: what crispy found, missed or got wrong. See [the five-line report](#a-five-line-report).
- **Report bugs** with the bug template (a minimal component + `crispy.config.json` is ideal).
- **Report a wrong hint** with the "Wrong or unhelpful fix hint" template: the row from the report
  and what was actually going on.
- **Pick an issue** labeled [`good first issue`](https://github.com/edgeorgie/crispy-profiling/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/edgeorgie/crispy-profiling/labels/help%20wanted).
- **Improve docs** — typos and unclear explanations count.

### A five-line report

The most useful issue right now fits in five lines. Example:

```text
App: Next.js 16 App Router, React 19.2, ~40 routes (private repo)
Command: npx crispy scan
Printed: Not tried: 12 clickable-looking element(s) without a short text to click them by (li ×12)
Expected: the order rows (an <li> with an onClick) to be clicked, like the buttons were
Changed: nothing yet; the rows are the flow that feels slow
```

Attach `.crispy/scan.json` or the report when you have it. Counts before and after a change
("Row 20 → 0 on search") are the best possible evidence for a hint.

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
# open PR release/0.2.0 -> main, merge it (merge commit), then either push the tag:
git checkout main && git pull && git tag v0.2.0 && git push origin v0.2.0
# ...or run Actions → Release → "Run workflow" with version 0.2.0, which tags main itself.
# Finally merge main back into develop with a merge commit (PR main -> develop).
```

The Release workflow publishes to npm (with provenance), the MCP Registry and GitHub releases, and
moves the major tag (`v0`) used by the GitHub Action. Re-running it is safe: steps that already
happened are skipped.

## Known CI hazards

### The default branch is `main`, but work lands on `develop`

`main` is the repository's **default branch**; `develop` is where every `feature/*`, `bugfix/*`,
`docs/*` and Dependabot PR merges. That split is a standing security-configuration hazard, because
`ossf/scorecard-action` **hard-refuses any non-default branch** on a push event:

```
validating options: only default branch is supported
refs/heads/develop not supported with push event.
##[error]Only the default branch main is supported.
```

So `.github/workflows/scorecard.yml` must trigger on `main`, and the copy that actually governs
scanning is the one committed on `main` — not the one you edit on `develop`. **Any
security-workflow change is therefore not in force until a `release/*` PR propagates it to
`main`.** That latency is a property of the layout, not a one-off: it is the window PR #132 had to
close by hand after #131.

Two mitigations are in place, and one is not:

- `scripts/check-scorecard-branch.ts` (run by the `Plugin & registry manifests` job) grades **both**
  the working copy in the checkout **and** the copy fetched from the default branch, so a stale
  trigger already in force fails CI on `develop` instead of hiding behind a green working copy.
- Adding `develop` to `scorecard.yml`'s push list is **not** an option — see the hard refusal above.
- The hazard is only *removed* by a repository-settings change no workflow can make: collapse to a
  single trunk (delete `develop`) or make `develop` the default branch. Until then the guard makes
  the drift detectable, not absent.

### `Code scanning AI findings on PR #128` is red and is expected

Run [`38072495139`](https://github.com/edgeorgie/crispy-profiling/actions/runs/38072495139)
(workflow `GitHub Advanced Security`, 2026-10-10) is a permanent `failure` in the Actions history.
It is **not** a finding in this repository's code: the single failing step reports
`errorType: 'quota'`, `statusCode: 402`, "You have exceeded your monthly quota" — a billing limit on
GitHub's hosted Copilot autofix service. It is PR-scoped to the already-merged #128, is not a
required status check on either protected branch, and the real scanners covering the same commit
(`CodeQL`, `Scorecard`) succeeded. No code change can clear it; restoring Copilot quota can.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

import { readFileSync } from 'node:fs';

/**
 * Asserts `.github/workflows/scorecard.yml` triggers on the repository's real
 * default branch.
 *
 * Why this exists: `ossf/scorecard-action` hard-refuses a push event on any
 * non-default branch ("Only the default branch <x> is supported"), so a
 * mismatch does not degrade the score — it makes the job permanently red
 * while the README keeps advertising its badge. That is what happened when
 * this repo's default branch moved `develop` -> `main`: nothing about a
 * default-branch rename reports that it invalidated a workflow trigger, and
 * the hand-maintained branch list silently became impossible to satisfy.
 *
 * The expected value is DERIVED at runtime from the live repository
 * (`github.event.repository.default_branch`, passed in as `DEFAULT_BRANCH`)
 * rather than restated as a second literal, since a literal mirror of the
 * default branch drifts exactly the way the workflow trigger did.
 */

const WORKFLOW = '.github/workflows/scorecard.yml';

/**
 * Extracts the `push.branches` list from a workflow's top-level `on:` block.
 *
 * Deliberately a narrow, dependency-free parse rather than a YAML load: this
 * runs as an early CI step, before `npm ci`, so it cannot rely on
 * node_modules. It understands only the one shape this file uses and throws
 * loudly — rather than returning `[]` — when the shape is anything else, so
 * an unparseable file can never be mistaken for a correctly-configured one.
 */
export function parsePushBranches(src: string): string[] {
  const lines = src.split('\n');

  // The top-level `on:` key at column 0, not a nested or quoted one.
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx === -1) throw new Error('no top-level `on:` block found');

  let inPush = false;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) break; // dedented out of the `on:` block
    const body = line.replace(/#.*$/, '');
    if (/^\s*$/.test(body)) continue;

    if (/^\s{2}push:\s*$/.test(body)) {
      inPush = true;
      continue;
    }
    // Any other two-space key closes the `push:` block, so a sibling
    // trigger's `branches:` is never read as push's.
    if (/^\s{2}\S/.test(body)) {
      inPush = false;
      continue;
    }
    if (!inPush) continue;

    const m = body.match(/^\s{4}branches:\s*\[(.*)\]\s*$/);
    if (m?.[1] !== undefined) {
      return m[1]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
  }
  throw new Error('`push.branches: [...]` not found in the `on:` block');
}

/**
 * Asserts the copy of the workflow living on the DEFAULT branch is the one
 * that can actually run.
 *
 * Why a second check: `checkScorecardBranch` below grades the *working copy*
 * in the checkout. Every feature, bugfix and Dependabot PR here targets
 * `develop`, but the file that governs when Scorecard runs is the copy on
 * `main`. So on a `develop` build the first check reads `develop`'s copy and
 * reports green while `main`'s copy may still be broken — which is exactly
 * the window PR #132 had to close by hand after #131. The guard as it stood
 * could not see a stale copy on the other branch.
 *
 * This check closes that blind spot by grading the default branch's copy,
 * fetched from the live repository and passed in as
 * `DEFAULT_BRANCH_WORKFLOW`.
 *
 * It deliberately does NOT require the two copies to be byte-identical. A PR
 * on `develop` that legitimately edits this workflow makes them differ until
 * the release merge lands, and failing on that would make correct work red.
 * The assertion is the semantic one that must hold at all times regardless of
 * what is in flight: the default branch's copy triggers on the default
 * branch. That is the only condition under which `scorecard-action` can
 * succeed on a push, and it is precisely the historical outage.
 */
export function checkDefaultBranchCopy(
  defaultBranch: string | undefined,
  remoteSrc: string | undefined,
): { code: 0 | 1 | 2; message: string } {
  if (!defaultBranch) {
    return {
      code: 2,
      message:
        'DEFAULT_BRANCH is empty. Refusing to pass: an unset expected value would ' +
        'make this gate succeed without checking anything.',
    };
  }
  if (!remoteSrc?.trim()) {
    return {
      code: 2,
      message:
        `DEFAULT_BRANCH_WORKFLOW is empty, so ${WORKFLOW} as it exists on ` +
        `"${defaultBranch}" could not be read. Refusing to pass: a gate that treats ` +
        'a failed fetch as "nothing wrong" is the vacuous pass this check exists to ' +
        'prevent. Re-run; if it persists, the fetch step itself is broken.',
    };
  }

  const branches = parsePushBranches(remoteSrc);
  if (branches.length === 1 && branches[0] === defaultBranch) {
    return {
      code: 0,
      message:
        `ok: ${WORKFLOW} on "${defaultBranch}" (the default branch, and the copy ` +
        `actually in force) triggers on [${branches[0]}]`,
    };
  }

  return {
    code: 1,
    message:
      `${WORKFLOW} as committed on the default branch "${defaultBranch}" has ` +
      `push.branches [${branches.join(', ')}].\n\n` +
      'That is the copy that governs when Scorecard runs, and scorecard-action only ' +
      'supports the default branch on a push event, so Scorecard is currently unable ' +
      'to succeed on this repository no matter what this branch contains:\n' +
      '  validating options: only default branch is supported\n' +
      `  ##[error]Only the default branch ${defaultBranch} is supported.\n\n` +
      `Fix: land the corrected ${WORKFLOW} on "${defaultBranch}" (per CONTRIBUTING.md, ` +
      'open the release PR) — a fix merged only to the integration branch is not in force.',
  };
}

/** Exit codes: 0 ok, 1 misconfigured, 2 the check itself could not run. */
export function checkScorecardBranch(
  defaultBranch: string | undefined,
  src: string,
): { code: 0 | 1 | 2; message: string } {
  if (!defaultBranch) {
    return {
      code: 2,
      message:
        'DEFAULT_BRANCH is empty. Refusing to pass: an unset expected value would ' +
        'make this gate succeed without checking anything.',
    };
  }

  const branches = parsePushBranches(src);
  if (branches.length === 1 && branches[0] === defaultBranch) {
    return {
      code: 0,
      message: `ok: ${WORKFLOW} triggers on [${branches[0]}], the repository's default branch`,
    };
  }

  return {
    code: 1,
    message:
      `${WORKFLOW}: push.branches is [${branches.join(', ')}] but the repository's ` +
      `default branch is "${defaultBranch}".\n\n` +
      'scorecard-action only supports the default branch on a push event, so this ' +
      'configuration cannot ever succeed:\n' +
      '  validating options: only default branch is supported\n' +
      `  ##[error]Only the default branch ${defaultBranch} is supported.\n\n` +
      `Fix: set push.branches to [${defaultBranch}] in ${WORKFLOW}.`,
  };
}

// Only act when executed as a script. Importing this module from a test must
// not read files or call process.exit — an import-time exit aborts the whole
// test file before a single case runs.
if (process.argv[1]?.includes('check-scorecard-branch')) {
  const defaultBranch = process.env.DEFAULT_BRANCH;

  // 1. The working copy in this checkout (catches a bad trigger before merge).
  // 2. The copy committed on the default branch (catches a stale trigger that
  //    is already in force — invisible to check 1 on a `develop` build).
  // Both must pass. The worst exit code wins so a "cannot run" is never
  // masked by the other check's success.
  const results = [
    checkScorecardBranch(defaultBranch, readFileSync(WORKFLOW, 'utf8')),
    checkDefaultBranchCopy(defaultBranch, process.env.DEFAULT_BRANCH_WORKFLOW),
  ];

  for (const { code, message } of results) {
    if (code === 0) console.log(message);
    else console.error(message);
  }
  process.exit(Math.max(...results.map((r) => r.code)) as 0 | 1 | 2);
}

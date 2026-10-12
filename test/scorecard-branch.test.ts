import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkScorecardBranch, parsePushBranches } from '../scripts/check-scorecard-branch.js';

/**
 * `ossf/scorecard-action` only supports the repository's default branch on a
 * push event. When this repo's default branch moved `develop` -> `main`, the
 * Scorecard workflow kept triggering on `develop`, so the only security job
 * here went permanently red while the README advertised its badge.
 *
 * The CI step derives the expected branch from the live repository, so these
 * tests cover what can still be wrong: the parse of the committed workflow,
 * and the verdict logic.
 */
describe('scorecard branch guard', () => {
  const wf = (body: string) => `name: Scorecard\n${body}\npermissions: read-all\n`;

  it("reads this repository's real scorecard workflow", () => {
    // Not a fixture: the on-disk file the gate actually grades.
    const src = readFileSync('.github/workflows/scorecard.yml', 'utf8');
    expect(parsePushBranches(src)).toEqual(['main']);
  });

  it('parses a quoted and unquoted branch list identically', () => {
    expect(parsePushBranches(wf('on:\n  push:\n    branches: [main]'))).toEqual(['main']);
    expect(parsePushBranches(wf('on:\n  push:\n    branches: ["main"]'))).toEqual(['main']);
    expect(parsePushBranches(wf("on:\n  push:\n    branches: ['main']"))).toEqual(['main']);
  });

  it('returns every branch, so a list of two cannot pass as a list of one', () => {
    // The regression: [main, develop] must be visible to the caller, not
    // collapsed to its first element.
    expect(parsePushBranches(wf('on:\n  push:\n    branches: [main, develop]'))).toEqual([
      'main',
      'develop',
    ]);
  });

  it('ignores a comment on the branches line', () => {
    expect(
      parsePushBranches(wf('on:\n  push:\n    branches: [main] # the default branch')),
    ).toEqual(['main']);
  });

  it('skips comments and blank lines inside the on: block', () => {
    expect(
      parsePushBranches(wf('on:\n  # MUST be the default branch\n\n  push:\n    branches: [main]')),
    ).toEqual(['main']);
  });

  it('does not read branches out of a sibling trigger', () => {
    // `pull_request.branches` is a different key; reading it here would make
    // the gate grade the wrong list.
    expect(
      parsePushBranches(
        wf('on:\n  pull_request:\n    branches: [develop]\n  push:\n    branches: [main]'),
      ),
    ).toEqual(['main']);
    expect(() => parsePushBranches(wf('on:\n  pull_request:\n    branches: [develop]'))).toThrow(
      /push\.branches/,
    );
  });

  it('finds push.branches when push is not the first trigger', () => {
    expect(
      parsePushBranches(
        wf(
          "on:\n  schedule:\n    - cron: '17 6 * * 1'\n  push:\n    branches: [main]\n  workflow_dispatch:",
        ),
      ),
    ).toEqual(['main']);
  });

  it('throws rather than silently returning [] when the shape is unknown', () => {
    // A gate that returns an empty list on an unparseable file would compare
    // [] against the default branch and fail confusingly, or worse, be
    // "fixed" by loosening the comparison. Fail loudly at the parse instead.
    expect(() => parsePushBranches('name: Scorecard\n')).toThrow(/no top-level `on:` block/);
    expect(() => parsePushBranches(wf('on:\n  push:\n    branches:\n      - main'))).toThrow(
      /push\.branches/,
    );
    expect(() => parsePushBranches(wf('on:\n  workflow_dispatch:'))).toThrow(/push\.branches/);
  });

  it('is not fooled by the word `on:` appearing later in the file', () => {
    const src = `${wf('on:\n  push:\n    branches: [main]')}jobs:\n  a:\n    steps:\n      - run: echo on:\n`;
    expect(parsePushBranches(src)).toEqual(['main']);
  });

  describe('verdict', () => {
    const good = wf('on:\n  push:\n    branches: [main]');

    it('passes when the trigger matches the default branch', () => {
      expect(checkScorecardBranch('main', good).code).toBe(0);
    });

    it('fails on the exact historical bug: trigger develop, default main', () => {
      const res = checkScorecardBranch('main', wf('on:\n  push:\n    branches: [develop]'));
      expect(res.code).toBe(1);
      expect(res.message).toMatch(/Only the default branch main is supported/);
    });

    it('fails when the list quietly gains a second branch', () => {
      expect(
        checkScorecardBranch('main', wf('on:\n  push:\n    branches: [main, develop]')).code,
      ).toBe(1);
    });

    it('refuses to pass vacuously when the expected value is missing', () => {
      // A gate whose expected value is unset must not report success: that is
      // indistinguishable from a real pass while checking nothing.
      expect(checkScorecardBranch(undefined, good).code).toBe(2);
      expect(checkScorecardBranch('', good).code).toBe(2);
    });

    it('tracks the default branch rather than hardcoding `main`', () => {
      // If the default branch were renamed again, the guard must follow it.
      expect(checkScorecardBranch('trunk', wf('on:\n  push:\n    branches: [trunk]')).code).toBe(0);
      expect(checkScorecardBranch('trunk', good).code).toBe(1);
    });
  });
});

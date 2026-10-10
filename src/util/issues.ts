/** Pre-filled links to the issue forms, so a report costs one click instead of a search. */
const ISSUES = 'https://github.com/edgeorgie/crispy-profiling/issues/new';

export function issueLink(
  template: 'tried_it' | 'bug_report' | 'wrong_hint',
  title: string,
): string {
  return `${ISSUES}?template=${template}.yml&title=${encodeURIComponent(title)}`;
}

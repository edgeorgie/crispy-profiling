/** Detects CI providers: generic `CI` (true/1) plus common provider variables. */
export function isCI(env = process.env): boolean {
  const ci = env.CI?.toLowerCase();
  if (ci === 'true' || ci === '1') return true;
  return [
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'BUILDKITE',
    'CIRCLECI',
    'TF_BUILD',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'BITBUCKET_BUILD_NUMBER',
  ].some((k) => Boolean(env[k]));
}

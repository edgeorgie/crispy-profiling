# Security Policy

## Supported versions

Only the latest minor release receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/edgeorgie/crispy-profilling/security/advisories/new).
You will get an answer within 7 days.

## Scope notes

- crispy-profiling launches a local headless browser and navigates to the URLs you configure.
  Only profile apps you trust.
- The MCP server runs locally over stdio. Its tools read and write report files at the paths the
  agent passes, with the permissions of the user that started it.

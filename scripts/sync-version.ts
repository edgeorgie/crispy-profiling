import { readFileSync, writeFileSync } from 'node:fs';

// Runs from the npm "version" lifecycle: copies package.json's version into the
// Claude Code plugin manifest, the MCP registry manifest and the GitHub Action, so
// every channel runs exactly the released version (never a floating "latest").
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

function update(file: string, mutate: (json: any) => void) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  mutate(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file} -> ${version}`);
}

update('.claude-plugin/plugin.json', (j) => {
  j.version = version;
  for (const server of Object.values<any>(j.mcpServers ?? {})) {
    server.args = server.args.map((a: string) =>
      a.startsWith('crispy-profiling@') ? `crispy-profiling@${version}` : a,
    );
  }
});
update('server.json', (j) => {
  j.version = version;
  for (const p of j.packages) p.version = version;
});

// action.yml: pin the default CLI version to the release.
const action = readFileSync('action.yml', 'utf8').replace(
  /( {2}version:\n {4}description: [^\n]*\n {4}default: )\S+/,
  `$1${version}`,
);
writeFileSync('action.yml', action);
console.log(`action.yml -> ${version}`);

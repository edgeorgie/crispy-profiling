import { readFileSync, writeFileSync } from 'node:fs';

// Runs from the npm "version" lifecycle: copies package.json's version into the
// Claude Code plugin manifest and the MCP registry manifest.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

function update(file: string, mutate: (json: any) => void) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  mutate(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file} -> ${version}`);
}

update('.claude-plugin/plugin.json', (j) => {
  j.version = version;
});
update('server.json', (j) => {
  j.version = version;
  for (const p of j.packages) p.version = version;
});

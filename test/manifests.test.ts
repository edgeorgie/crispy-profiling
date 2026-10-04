import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

describe('distribution manifests', () => {
  const pkg = read('package.json');
  const plugin = read('.claude-plugin/plugin.json');
  const marketplace = read('.claude-plugin/marketplace.json');
  const server = read('server.json');

  it('share one version (run `npm version <bump>` to keep them in sync)', () => {
    expect(plugin.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) expect(p.version).toBe(pkg.version);
  });

  it('pin the Action to the package version', () => {
    expect(readFileSync('action.yml', 'utf8')).toMatch(
      new RegExp(
        `version:\\n    description: [^\\n]*\\n    default: ${pkg.version.replace(/\./g, '\\.')}\\n`,
      ),
    );
  });

  it('point to the same npm package and MCP name', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(plugin.mcpServers['crispy-profiling'].args).toContain(`${pkg.name}@${pkg.version}`);
    expect(marketplace.plugins[0].name).toBe(plugin.name);
  });

  it('ship a skill with valid frontmatter', () => {
    const skill = readFileSync('skills/react-render-profiling/SKILL.md', 'utf8');
    const fm = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(fm).toMatch(/^name: react-render-profiling$/m);
    const description = fm.match(/^description: (.+)$/m)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});

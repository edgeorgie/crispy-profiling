import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { buildFixture, serve } from './helpers.js';

let client: Client;
let app: { url: string; close: () => Promise<void> };
const tmp = mkdtempSync(join(tmpdir(), 'crispy-mcp-'));

const textOf = (r: any): string => r.content.map((c: any) => c.text).join('\n');

beforeAll(async () => {
  app = await serve((await buildFixture()).slow);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await app.close();
});

describe('MCP server', () => {
  it('exposes the documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_reports',
      'inspect_component',
      'profile_url',
      'run_scenarios',
      'test_render_snapshots',
    ]);
  });

  it('profiles a URL, saves the report and inspects a component', async () => {
    const outFile = join(tmp, 'report.json');
    const res = await client.callTool({
      name: 'profile_url',
      arguments: { url: `${app.url}/`, steps: [{ action: 'click', selector: '#inc' }], outFile },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('Phase `interaction`');
    expect(textOf(res)).toContain('`onSelect` is a new function');

    const inspect = await client.callTool({
      name: 'inspect_component',
      arguments: { reportPath: outFile, component: 'Header' },
    });
    const parsed = JSON.parse(textOf(inspect));
    expect(parsed['page/interaction'].wastedRenders.median).toBe(1);

    const cmp = await client.callTool({
      name: 'compare_reports',
      arguments: { basePath: outFile, headPath: outFile },
    });
    expect(textOf(cmp)).toContain('no render regressions');
  });

  it('refuses to update the snapshot without explicit confirmation (R2-23)', async () => {
    const res = await client.callTool({
      name: 'test_render_snapshots',
      arguments: { configPath: join(tmp, 'missing.json'), update: true },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('confirm="accept-render-changes"');
  });

  it('returns tool errors instead of throwing', async () => {
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{"hello":1}');
    const res = await client.callTool({
      name: 'compare_reports',
      arguments: { basePath: bad, headPath: bad },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('not a crispy-profiling report');
  });
});

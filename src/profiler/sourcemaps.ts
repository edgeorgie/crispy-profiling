import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { shortPath } from '../util/paths.js';

export type FetchText = (url: string) => Promise<string | null>;

const MAP_COMMENT = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/gm;

/**
 * Maps runtime positions (what the browser executes: bundles, dev-server
 * transforms) back to original source files and lines using source maps.
 */
export class SourceMapResolver {
  private maps = new Map<string, Promise<TraceMap | null>>();

  constructor(
    private readonly fetchText: FetchText,
    private readonly root = process.cwd(),
  ) {}

  private load(scriptUrl: string): Promise<TraceMap | null> {
    let pending = this.maps.get(scriptUrl);
    if (!pending) {
      pending = this.fetchMap(scriptUrl).catch(() => null);
      this.maps.set(scriptUrl, pending);
    }
    return pending;
  }

  private async fetchMap(scriptUrl: string): Promise<TraceMap | null> {
    if (!/^https?:\/\//.test(scriptUrl)) return null;
    const code = await this.fetchText(scriptUrl);
    if (!code) return null;
    const refs = [...code.matchAll(MAP_COMMENT)];
    const ref = refs[refs.length - 1]?.[1];
    if (!ref) return null;
    if (ref.startsWith('data:')) {
      const comma = ref.indexOf(',');
      const payload = ref.slice(comma + 1);
      const json = ref.slice(0, comma).endsWith(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return new TraceMap(json, scriptUrl);
    }
    const mapUrl = new URL(ref, scriptUrl).toString();
    const json = await this.fetchText(mapUrl);
    return json ? new TraceMap(json, mapUrl) : null;
  }

  /** Turns a resolved source URL into a short project-relative path. */
  private display(source: string): string {
    const path = shortPath(source).replace(/^(\.\/)+/, '');
    // Sources that resolve to absolute file-system paths: make them project-relative.
    const abs = `/${path}`;
    if (abs.startsWith(`${this.root}/`)) return relative(this.root, abs);
    // A real file outside the project (e.g. a monorepo sibling): keep it absolute.
    if (existsSync(abs)) return abs;
    return path;
  }

  /** `line` and `column` are 1-based, as in stack traces. */
  async resolve(
    url: string,
    line: number,
    column: number,
  ): Promise<{ file: string; line: number } | null> {
    const map = await this.load(url);
    if (!map) return null;
    const pos = originalPositionFor(map, { line, column: Math.max(0, column - 1) });
    if (!pos.source || pos.line == null) return null;
    return { file: this.display(pos.source), line: pos.line };
  }

  /**
   * Rewrites a raw location "url:line:col (Owner)" to "file:line (Owner)", using
   * the original source when a source map is available.
   */
  async rewriteLocation(raw: string): Promise<string> {
    const m = raw.match(/^(.*):(\d+):(\d+)( \(.*\))?$/);
    if (!m) return raw;
    const [, url, line, col, owner = ''] = m as unknown as [
      string,
      string,
      string,
      string,
      string?,
    ];
    const mapped = await this.resolve(url, Number(line), Number(col));
    return mapped
      ? `${mapped.file}:${mapped.line}${owner}`
      : `${this.display(url)}:${line}${owner}`;
  }
}

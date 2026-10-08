import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { FlattenMap, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping';
import { shortPath } from '../util/paths.js';

export type FetchText = (url: string) => Promise<string | null>;

/** Scripts that are library code: node_modules, Vite's prebundled deps, Next's dist chunks. */
export const isLibraryScript = (url: string) =>
  /node_modules[/_]|\.vite\/deps\/|_next_dist_|(^|\/)next\/dist\//.test(url);

const nodeModulesPath = (p: string) => {
  const i = p.lastIndexOf('node_modules/');
  return i >= 0 ? p.slice(i) : null;
};

/** Short path of a generated script, anchored at node_modules when it lives there. */
const shortPathOf = (url: string) => {
  const short = shortPath(url).replace(/^(\.\/)+/, '');
  return nodeModulesPath(short) ?? short;
};

const MAP_COMMENT = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/gm;

/** Nearest directory containing `.git` (monorepos), else the start directory. */
export function findProjectRoot(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Parses regular and sectioned (index) source maps — Turbopack serves the
 * latter, which the plain TraceMap constructor rejects.
 */
const parseMap = (json: string, url: string): TraceMap => FlattenMap(json, url);

/**
 * Maps runtime positions (what the browser executes: bundles, dev-server
 * transforms) back to original source files and lines using source maps.
 */
export class SourceMapResolver {
  private maps = new Map<string, Promise<TraceMap | null>>();

  constructor(
    private readonly fetchText: FetchText,
    private readonly root = findProjectRoot(),
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
    // fetchText also resolves non-HTTP scripts (e.g. webpack's eval'd
    // `webpack-internal:///` modules) through the DevTools protocol.
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
      return parseMap(json, scriptUrl);
    }
    const mapUrl = new URL(ref, scriptUrl).toString();
    const json = await this.fetchText(mapUrl);
    return json ? parseMap(json, mapUrl) : null;
  }

  /**
   * Turns a resolved source URL into a short, portable path: project-relative
   * for app files, `node_modules/...` for library code. Never a path that only
   * exists on this machine, so snapshots are identical everywhere.
   * `generated` is the script the code ran from: when it is library code
   * (node_modules, Next's `_next_dist_` chunks) and the mapped source is not a
   * project file, the source belongs to that library — e.g. Next's own maps
   * point at `webpack://next/src/...` or at its build machine's directories.
   */
  private display(source: string, generated?: string): string {
    return this.place(source, generated).file;
  }

  /** `generatedFile`: the source was unusable and the generated script is reported instead. */
  private place(source: string, generated?: string): { file: string; generatedFile?: true } {
    const file = this.placeFile(source, generated);
    return file === null
      ? { file: shortPathOf(generated as string), generatedFile: true }
      : { file };
  }

  private placeFile(source: string, generated?: string): string | null {
    const path = shortPath(source).replace(/^(\.\/)+/, '');
    const lib = nodeModulesPath(path);
    if (lib) return lib;
    // Sources that resolve to absolute file-system paths: make them project-relative.
    const abs = path.startsWith('/') ? path : `/${path}`;
    if (abs.startsWith(`${this.root}/`)) return relative(this.root, abs);
    if (generated && isLibraryScript(generated)) {
      const pkg = source.match(/^webpack:\/\/([^/_.][^/]*)\/(?:\.\/)?(.*)$/);
      if (pkg) return `node_modules/${pkg[1]}/${pkg[2]}`;
      return null;
    }
    // A real file outside the project (e.g. a sibling package): relative to the root.
    if (existsSync(abs)) return relative(this.root, abs);
    return path;
  }

  /** `line` and `column` are 1-based, as in stack traces. */
  async resolve(
    url: string,
    line: number,
    column: number,
  ): Promise<{ file: string; line: number; name?: string } | null> {
    const map = await this.load(url);
    if (!map) return null;
    const pos = originalPositionFor(map, { line, column: Math.max(0, column - 1) });
    if (!pos.source || pos.line == null) return null;
    const placed = this.place(pos.source, url);
    return {
      file: placed.file,
      line: placed.generatedFile ? line : pos.line,
      ...(pos.name && { name: pos.name }),
    };
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

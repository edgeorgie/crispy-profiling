/** Strips origin, bundler prefixes and query so file paths are portable across hosts. */
export function shortPath(url: string): string {
  return (
    url
      .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?(\.\/)?/, '')
      .replace(/^[a-z]+:\/\/[^/]*\//i, '')
      // Vite serves files outside the project root as /@fs/<absolute path>.
      .replace(/^@fs\//, '/')
      .replace(/[?#].*$/, '')
  );
}

/** Library code: node_modules, Vite's prebundled deps, Next's dist chunks. */
export const LIBRARY_FILE =
  /(^|\/)node_modules(\/|_)|\.vite\/deps\/|(^|\/)next\/dist\/|_next_dist_/;

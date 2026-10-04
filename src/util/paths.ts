/** Strips origin, bundler prefixes and query so file paths are portable across hosts. */
export function shortPath(url: string): string {
  return url
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?(\.\/)?/, '')
    .replace(/^[a-z]+:\/\/[^/]*\//i, '')
    .replace(/[?#].*$/, '');
}

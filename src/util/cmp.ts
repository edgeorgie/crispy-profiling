/** Locale-independent string comparison, so ordering is identical on every machine. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Like `cmp`, but digit runs compare as numbers, so `App.tsx:9` sorts before `App.tsx:10`.
 * Still locale-independent and deterministic.
 */
export function cmpNatural(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    const d = nx && ny ? Number(x) - Number(y) || cmp(x, y) : cmp(x, y);
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

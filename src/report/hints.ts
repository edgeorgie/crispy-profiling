import type { ComponentReport, PhaseReport } from '../types.js';

const code = (keys: string[]) => keys.map((k) => `\`${k}\``).join(', ');
const top = (m: Record<string, number>, n = 3) => Object.keys(m).slice(0, n);

/** "file:line (Owner)" → { where: " (rendered at file:line)", owner: "Owner" } */
function site(c: ComponentReport): { where: string; owner: string | null } {
  const loc = c.locations[0];
  if (!loc) return { where: '', owner: null };
  const owner = loc.match(/ \((.+)\)$/)?.[1] ?? null;
  return { where: ` (rendered at ${loc})`, owner };
}

/** Renders of other components in this phase that `name` triggered with its state updates. */
function cascadeOf(name: string, phase: PhaseReport | undefined): { total: number; top: string[] } {
  if (!phase) return { total: 0, top: [] };
  const hits = Object.entries(phase.components)
    .map(([k, c]) => [k, c.triggeredBy[name] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return { total: hits.reduce((a, [, n]) => a + n, 0), top: hits.slice(0, 3).map(([k]) => k) };
}

/**
 * Explains why a component re-rendered and what to change, pointing at the root
 * cause rather than the symptom: the component whose state started the cascade,
 * the owner that recreates a prop, or the provider that recreates a context value.
 */
export function hintFor(
  c: ComponentReport | undefined,
  phase?: PhaseReport,
  name?: string,
): string | undefined {
  if (!c) return undefined;
  const { where, owner } = site(c);
  const fixIn = owner ? ` in \`${owner}\`` : '';
  const memoNote = c.memo
    ? ` It is already wrapped in React.memo; the recreated prop defeats it.`
    : ' Then wrap this component in React.memo.';

  // Root cause of a cascade: its own state updates re-render many components below.
  if (name && c.causes.state > 0) {
    const cascade = cascadeOf(name, phase);
    if (cascade.total >= 3) {
      return `state updates here re-render ${cascade.total} component render(s) below (${code(cascade.top)})${where}. Move this state closer to the components that use it, or make the props passed down stable so React.memo can skip them.`;
    }
  }
  const contexts = top(c.recreatedContextFrom);
  if (contexts.length) {
    return `reads a context whose value is recreated on every render of ${code(contexts)}: memoize the provider value there with useMemo (and useCallback for functions inside it).`;
  }
  const unstable = top(c.unstableProps);
  if (unstable.length) {
    return `${code(unstable)} recreated on every render with equal data${where}: hoist it out of the component or memoize it with useMemo${fixIn}.${memoNote}`;
  }
  const callbacks = top(c.callbackProps);
  if (callbacks.length) {
    return `${code(callbacks)} is a new function with the same code on every render${where}. If the values it uses did not change, wrap it in useCallback with those values as dependencies${fixIn};${c.memo ? ' it is already wrapped in React.memo, so that removes the render.' : ' then wrap this component in React.memo.'} If they did change, this render is necessary. (React Compiler can do this automatically, except for closures created inside loops.)`;
  }
  const trigger = top(c.triggeredBy, 1)[0];
  if (c.causes.parent > 0) {
    const because = trigger ? `\`${trigger}\` updates its state` : 'its parent re-renders';
    return `re-renders with identical props because ${because}${where}: wrap it in React.memo, or move ${trigger ? `\`${trigger}\`'s` : 'the parent’s'} state closer to where it is used.`;
  }
  if (c.causes.context > 0) {
    return `re-renders when a context value changes${where}: split the context so it only reads what it needs, or select a smaller slice.`;
  }
  if (c.causes.state > 0) {
    return `its own state updates${where}: check for extra setState calls or effects that set state after render.`;
  }
  const changed = top(c.changedProps);
  if (changed.length) {
    return `props changed: ${code(changed)}${trigger ? ` (cascade started by \`${trigger}\`)` : ''}${where}.`;
  }
  return undefined;
}

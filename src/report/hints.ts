import type { ComponentReport, PhaseReport } from '../types.js';
import { LIBRARY_FILE } from '../util/paths.js';

const code = (keys: string[]) => keys.map((k) => `\`${k}\``).join(', ');
const top = (m: Record<string, number>, n = 3) => Object.keys(m).slice(0, n);

/** "file:line (Owner)" → { where: " (rendered at file:line (Owner))", owner: "Owner" } */
function site(c: ComponentReport): { where: string; owner: string | null } {
  const loc = c.locations[0];
  if (!loc) return { where: '', owner: null };
  const owner = loc.match(/ \((.+)\)$/)?.[1] ?? null;
  return { where: ` (rendered at ${loc})`, owner };
}

/**
 * Avoidable renders of other components that `name`'s state updates caused:
 * renders below it that changed nothing (or only recreated callbacks).
 */
function cascadeOf(name: string, phase: PhaseReport | undefined): { total: number; top: string[] } {
  if (!phase) return { total: 0, top: [] };
  const hits = Object.entries(phase.components)
    .map(([k, c]) => {
      const fixable = c.avoidableRenders.median + c.callbackRenders.median;
      return [k, Math.min(c.triggeredBy[name] ?? 0, fixable)] as const;
    })
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return { total: hits.reduce((a, [, n]) => a + n, 0), top: hits.slice(0, 3).map(([k]) => k) };
}

/** First entry of a "prop|Creator[|extra]" count map for `prop`. */
function lookup(m: Record<string, number>, prop: string): string[] | null {
  const key = Object.keys(m).find((k) => k.startsWith(`${prop}|`));
  return key ? key.split('|').slice(1) : null;
}

/** How to fix one recreated prop, naming the component that creates it. */
function propFix(c: ComponentReport, prop: string, owner: string | null): string {
  const creator = lookup(c.creators, prop)?.[0] ?? owner;
  const inCreator = creator ? ` in \`${creator}\`` : '';
  const stale = lookup(c.staleMemo, prop);
  if (stale?.[1]) {
    return `\`${prop}\` is already memoized${inCreator}, but its dependency ${stale[1]} changes on every render: make that dependency stable (memoize it, or read it inside the callback)`;
  }
  if (c.unstableProps[prop]) {
    return `\`${prop}\` is recreated with equal data${inCreator}: hoist it out of the component or wrap it in useMemo`;
  }
  return `\`${prop}\` is a new function with the same code${inCreator}: wrap it in useCallback with the values it uses as dependencies`;
}

/**
 * Explains why a component re-rendered and what to change, pointing at the root
 * cause rather than the symptom: the component whose state started the cascade,
 * the component that creates a recreated prop, or the provider that recreates a
 * context value. Library components are never told to change themselves.
 */
export function hintFor(
  c: ComponentReport | undefined,
  phase?: PhaseReport,
  name?: string,
): string | undefined {
  if (!c) return undefined;
  const { where, owner } = site(c);
  const library = c.definedIn !== undefined && LIBRARY_FILE.test(c.definedIn);

  // Root cause of a cascade: its state updates cause avoidable renders below.
  if (name && c.causes.state > 0) {
    const cascade = cascadeOf(name, phase);
    if (cascade.total >= 3) {
      return `state updates here cause ${cascade.total} avoidable render(s) below (${code(cascade.top)})${where}. Make the props passed down stable so React.memo can skip them, or move this state closer to the components that use it.`;
    }
  }

  const contexts = top(c.recreatedContextFrom);
  if (contexts.length) {
    const at = c.providerAt[0] ? ` (${c.providerAt[0].replace(/ \(.*\)$/, '')})` : '';
    return `reads a context whose value is recreated on every render of ${code(contexts)}${at}: memoize the provider value there with useMemo (and useCallback for functions inside it).`;
  }

  const recreated = [...Object.keys(c.unstableProps), ...Object.keys(c.callbackProps)];
  const props = [...new Set(recreated)].filter((p) => p !== 'children');
  if (props.length) {
    const shown = props.slice(0, 4);
    const more = props.length > shown.length ? `; and ${props.length - shown.length} more` : '';
    const fixes = shown.map((p) => propFix(c, p, owner)).join('; ');
    const creators = shown.map((p) => lookup(c.creators, p)?.[0] ?? owner);
    const compiled = creators.find((k) => k && phase?.components[k]?.compiled);
    const notes = [
      compiled
        ? `React Compiler is on in \`${compiled}\`, yet the value is recreated: it is probably created inside a loop or depends on a value that changes.`
        : '',
      library
        ? 'This is library code: fix the props where you pass them, not the component.'
        : c.memo
          ? 'It is already wrapped in React.memo, so stable props remove these renders.'
          : 'Then wrap this component in React.memo.',
      Object.keys(c.callbackProps).length
        ? 'If the values a callback uses really change, that render is necessary.'
        : '',
    ].filter(Boolean);
    return `recreated on every render${where}: ${fixes}${more}. ${notes.join(' ')}`;
  }

  if (recreated.includes('children')) {
    return `receives new \`children\` elements on every render${where}: that is how JSX works, and React.memo will not help. If it is expensive, stop ${owner ? `\`${owner}\`` : 'the parent'} from re-rendering, or pass the children from a component that does not re-render.`;
  }

  const trigger = top(c.triggeredBy, 1)[0];
  if (c.causes.parent > 0) {
    const because = trigger ? `\`${trigger}\` updates its state` : 'its parent re-renders';
    if (library) {
      return `library component re-rendered with identical props because ${because}${where}. Nothing to change here; if it matters, stop ${owner ? `\`${owner}\`` : 'its parent'} from re-rendering.`;
    }
    return `re-renders with identical props because ${because}${where}: wrap it in React.memo, or move ${trigger ? `\`${trigger}\`'s` : 'the parent’s'} state closer to where it is used.`;
  }
  if (c.causes.context > 0) {
    return `re-renders when a context value changes${where}: split the context so it only reads what it needs, or select a smaller slice.`;
  }
  if (c.causes.state > 0) {
    return `its own state changed (a setState call or new data, e.g. a query result)${where}. If it renders more often than its data changes, look for effects that set state after render.`;
  }
  const changed = top(c.changedProps);
  if (changed.length) {
    return `props changed: ${code(changed)}${trigger ? ` (cascade started by \`${trigger}\`)` : ''}${where}.`;
  }
  return undefined;
}

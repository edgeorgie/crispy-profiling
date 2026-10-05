import type { ComponentReport, PhaseReport } from '../types.js';
import { LIBRARY_FILE } from '../util/paths.js';

const code = (keys: string[]) => keys.map((k) => `\`${k}\``).join(', ');
const top = (m: Record<string, number>, n = 3) => Object.keys(m).slice(0, n);

/** "file:line (Owner)" → { where: " (rendered at file:line (Owner))", owner: "Owner" } */
function site(c: ComponentReport): { where: string; owner: string | null } {
  // Prefer a site in app code over one inside a library (e.g. emotion's styled wrapper).
  const loc =
    c.locations.find((l) => !LIBRARY_FILE.test(l.replace(/ \(.*\)$/, ''))) ?? c.locations[0];
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

/** " (`query` (useState))": the state that changed, when known. */
const stateOf = (c: ComponentReport) => {
  const what = Object.keys(c.stateChanges ?? {})[0];
  return what ? ` (${what})` : '';
};

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
  const isLibrary = (k: string | null | undefined) => {
    const file = k ? phase?.components[k]?.definedIn : undefined;
    return file !== undefined && LIBRARY_FILE.test(file);
  };

  // Root cause of a cascade: its state updates cause avoidable renders below.
  // Library components (routers, error boundaries) are never the place to fix.
  if (name && c.causes.state > 0 && !library) {
    const cascade = cascadeOf(name, phase);
    if (cascade.total >= 3) {
      return `state updates here${stateOf(c)} cause ${cascade.total} avoidable render(s) below (${code(cascade.top)})${where}. Make the props passed down stable so React.memo can skip them, or move this state closer to the components that use it.`;
    }
  }

  const contexts = top(c.recreatedContextFrom).filter((k) => !isLibrary(k));
  if (contexts.length) {
    const at = c.providerAt[0] ? ` (${c.providerAt[0].replace(/ \(.*\)$/, '')})` : '';
    const stale = lookup(c.staleMemo, '(context value)');
    if (stale?.[1]) {
      return `reads a context whose value is already memoized in \`${stale[0]}\`${at}, but its dependency ${stale[1]} changes on every render: make that dependency stable.`;
    }
    return `reads a context whose value is recreated on every render of ${code(contexts)}${at}: memoize the provider value there with useMemo (and useCallback for functions inside it).`;
  }

  const recreated = [...Object.keys(c.unstableProps), ...Object.keys(c.callbackProps)];
  // Props created inside library code cannot be fixed from the app: skip them.
  const props = [...new Set(recreated)].filter(
    (p) => p !== 'children' && !isLibrary(lookup(c.creators, p)?.[0]),
  );
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
    if (library) {
      return `library component reading a context value that changed${where}: this render is necessary.`;
    }
    return `re-renders when a context value changes${where}: split the context so it only reads what it needs, or select a smaller slice.`;
  }
  if (c.causes.state > 0) {
    const what = top(c.stateChanges, 1)[0];
    if (what?.startsWith('store subscription')) {
      return `a store or router subscription changed (${what.replace(/^store subscription \(useSyncExternalStore\)( via )?/, '') || 'useSyncExternalStore'})${where}: select only what this component needs (e.g. the pathname instead of the whole location, or a primitive instead of a new object), or move the subscription into the child that uses it.`;
    }
    return `its own state changed${what ? `: ${what}` : ' (a setState call or new data, e.g. a query result)'}${where}. If it renders more often than its data changes, look for effects that set state after render.`;
  }
  const changed = top(c.changedProps);
  if (changed.length) {
    return `props changed: ${code(changed)}${trigger ? ` (cascade started by \`${trigger}\`)` : ''}${where}.`;
  }
  return undefined;
}

export interface RootCause {
  /** One-line, Markdown-ready explanation with the fix. */
  text: string;
  /** Avoidable or callback renders this cause is responsible for (for ranking). */
  renders: number;
}

/**
 * Groups a phase's avoidable renders by root cause, so a phase with thousands
 * of renders reads as a handful of fixes: values recreated by one component,
 * context values recreated by one provider, and state updates that re-render
 * unchanged children — with the child where one React.memo stops most of them.
 */
export function rootCauses(phase: PhaseReport, max = 5): RootCause[] {
  const comps = Object.entries(phase.components);
  const libraryKey = (k: string) => {
    const f = phase.components[k]?.definedIn;
    return f !== undefined && LIBRARY_FILE.test(f);
  };
  const fixable = (c: ComponentReport) => c.avoidableRenders.median + c.callbackRenders.median;
  const out: RootCause[] = [];

  // 1. Props recreated by the same component.
  const byCreator = new Map<string, { renders: number; affected: string[] }>();
  for (const [name, c] of comps) {
    const n = fixable(c);
    if (!n) continue;
    for (const key of Object.keys(c.creators)) {
      const [prop, creator] = key.split('|') as [string, string];
      if (prop === 'children' || libraryKey(creator)) continue;
      const id = `${creator}|${prop}`;
      const e = byCreator.get(id) ?? { renders: 0, affected: [] };
      e.renders += n;
      if (!e.affected.includes(name)) e.affected.push(name);
      byCreator.set(id, e);
    }
  }
  for (const [id, e] of byCreator) {
    const [creator, prop] = id.split('|') as [string, string];
    const stale = comps
      .map(([, c]) => Object.keys(c.staleMemo).find((k) => k.startsWith(`${prop}|${creator}|`)))
      .find(Boolean)
      ?.split('|')[2];
    const fix = stale
      ? `it is memoized, but its dependency ${stale} changes every render: stabilize that dependency`
      : 'memoize it there (useCallback / useMemo, or hoist a constant)';
    out.push({
      renders: e.renders,
      text: `\`${creator}\` recreates \`${prop}\` → ${e.renders} avoidable render(s) in ${code(e.affected.slice(0, 3))}${e.affected.length > 3 ? ` and ${e.affected.length - 3} more` : ''}: ${fix}.`,
    });
  }

  // 2. Context values recreated by the same provider owner.
  const byProvider = new Map<string, { renders: number; affected: string[] }>();
  for (const [name, c] of comps) {
    for (const owner of Object.keys(c.recreatedContextFrom)) {
      if (libraryKey(owner)) continue;
      const e = byProvider.get(owner) ?? { renders: 0, affected: [] };
      e.renders += fixable(c);
      e.affected.push(name);
      byProvider.set(owner, e);
    }
  }
  for (const [owner, e] of byProvider) {
    if (!e.renders) continue;
    out.push({
      renders: e.renders,
      text: `\`${owner}\` recreates a context value → ${e.renders} avoidable render(s) in ${code(e.affected.slice(0, 3))}: memoize the provider value (useMemo).`,
    });
  }

  // 3. State updates that re-render unchanged children, with the best React.memo boundary.
  const ownerOf = (c: ComponentReport) => c.locations[0]?.match(/ \((.+)\)$/)?.[1];
  for (const [trigger, t] of comps) {
    if (!t.causes.state || libraryKey(trigger)) continue;
    // Only renders with no other explanation (wasted): recreated props and
    // context values are already listed above as their own root causes.
    const wasted = (c: ComponentReport) =>
      Math.min(c.triggeredBy[trigger] ?? 0, c.wastedRenders.median);
    const hit = comps.filter(([, c]) => wasted(c) > 0);
    const total = hit.reduce((a, [, c]) => a + wasted(c), 0);
    if (total < 3) continue;
    // Renders saved by memoizing a direct child: the child plus everything it owns below.
    const below = (root: string): number => {
      const seen = new Set<string>([root]);
      let sum = 0;
      for (let grew = true; grew; ) {
        grew = false;
        for (const [k, c] of hit) {
          const o = ownerOf(c);
          if (!seen.has(k) && o && seen.has(o)) {
            seen.add(k);
            grew = true;
          }
        }
      }
      for (const [k, c] of hit) if (seen.has(k)) sum += wasted(c);
      return sum;
    };
    const boundary = hit
      .filter(
        ([k, c]) => ownerOf(c) === trigger && !libraryKey(k) && !c.memo && c.causes.parent > 0,
      )
      .map(([k]) => [k, below(k)] as const)
      .sort((a, b) => b[1] - a[1])[0];
    const memo =
      boundary && boundary[1] > 1
        ? ` Wrapping \`${boundary[0]}\` in React.memo would skip ${boundary[1]} of them (if its props are stable).`
        : '';
    out.push({
      renders: total,
      text: `\`${trigger}\` state updates${stateOf(t)} re-render ${total} unchanged component render(s) below.${memo} Or move that state closer to where it is used.`,
    });
  }

  return out.sort((a, b) => b.renders - a.renders || (a.text < b.text ? -1 : 1)).slice(0, max);
}

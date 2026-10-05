import type { ComponentReport, PhaseReport } from '../types.js';
import { cmp } from '../util/cmp.js';
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

/** " (`query` (useState))": the state that changed, when known (not one an effect sets). */
const stateOf = (c: ComponentReport) => {
  const keys = Object.keys(c.stateChanges ?? {});
  const what = keys.find((k) => !c.effectCascades?.[k]) ?? keys[0];
  return what ? ` (${what})` : '';
};

/** State this component's useEffect sets right after a render, and what it costs. */
export function effectCascade(c: ComponentReport): {
  total: number;
  renders: number;
  states: string[];
  fix: string;
} {
  const m = c.effectCascades ?? {};
  const states = Object.keys(m);
  const total = c.cascadeCommits ?? Object.values(m).reduce((a, n) => a + n, 0);
  const fix = states.some((k) => k.endsWith('(via a prop)'))
    ? "call the parent's setter in the event handler instead, or lift the state up and compute it during render"
    : states.some((k) => k.startsWith('a store read by'))
      ? 'update it in the event handler that changes its input, or derive it where it is read (a selector or during render)'
      : 'compute the value during render (useMemo if it is expensive) or set it in the event handler that changes its input';
  return { total, renders: c.cascadeRenders ?? total, states, fix };
}

/** Every changed dependency is a primitive (e.g. the search text): it really changes. */
const realChange = (deps: string) =>
  /\((string|number|boolean|bigint|undefined|symbol)\)/.test(deps) &&
  !/\((an object|an array|a function)\)/.test(deps);

/** How to fix a useCallback/useMemo whose dependencies change. */
function depFix(what: string, deps: string): string {
  return realChange(deps)
    ? `${what} is memoized, but its dependency ${deps} really changes (a new value, not just a new object): that render is expected. To avoid it, read the value when the callback runs (a state updater like \`setX(x => …)\`, or a ref) instead of listing it as a dependency`
    : `${what} is memoized, but its dependency ${deps} is recreated on every render: memoize it where it is created, or read it inside the callback (a state updater like \`setX(x => …)\`, or a ref) instead of listing it`;
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
    return depFix(`\`${prop}\`${inCreator}`, stale[1]);
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
    if (!k) return false;
    if (phase?.library?.includes(k)) return true;
    const file = phase?.components[k]?.definedIn;
    return file !== undefined && LIBRARY_FILE.test(file);
  };

  // State set in a useEffect right after a render: an extra commit every time.
  const effect = effectCascade(c);
  if (effect.total > 0 && !library) {
    const shown = effect.states.slice(0, 3).join(', ');
    const more = effect.states.length > 3 ? ` and ${effect.states.length - 3} more` : '';
    return `a useEffect here sets ${shown}${more} right after rendering, ${effect.total} time(s)${where}: each one is an extra commit (${effect.renders} render(s) in total). To fix, ${effect.fix}. If the effect reads the DOM (sizes, positions), move it to useLayoutEffect to avoid a visible flash.`;
  }

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
      return `reads a context whose value ${depFix(`in \`${stale[0]}\`${at}`, stale[1])}.`;
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

  // React.memo that never skipped a render while props really changed: pure cost.
  if (c.uselessMemo && !library && c.updates.median > 0 && c.causes.props > 0) {
    const changed = top(c.changedProps);
    return `React.memo did not skip any render in these flows${where}: ${changed.length ? code(changed) : 'its props'} changed on every update, so the comparison only adds cost here. Consider removing it, unless other flows rely on it or you are about to make those props stable.`;
  }

  const trigger = top(c.triggeredBy, 1)[0];
  if (c.causes.parent > 0) {
    const because = trigger ? `\`${trigger}\` updates its state` : 'its parent re-renders';
    if (library) {
      return `library component re-rendered with identical props because ${because}${where}. Nothing to change here; if it matters, stop ${owner ? `\`${owner}\`` : 'its parent'} from re-rendering.`;
    }
    if (c.mutableReads && !c.wastedRenders.median) {
      return `re-renders with identical props because ${because}${where}, and its output changes anyway: it reads data that changes without changing its props (a mutable object such as a table or form instance, a ref, or a global). These renders are needed — do not wrap it in React.memo (it would show stale data). To skip them, pass the values it shows as props.`;
    }
    const masked = top(c.maskedContextFrom ?? {}).filter((k) => !isLibrary(k));
    if (masked.length) {
      return `re-renders with identical props because ${because}${where}, and it reads a context whose value ${code(masked)} recreates on every render: React.memo alone will not skip it. Memoize that provider value (useMemo) first, then wrap it in React.memo.`;
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
      const hook = what.replace(/^store subscription \(useSyncExternalStore\)\s*/, '');
      const below = name ? cascadeOf(name, phase).total : 0;
      // Only advise when the subscription costs avoidable renders below; otherwise the
      // render is how the component shows new data.
      return below > 0
        ? `a store or router subscription changed (${hook || 'useSyncExternalStore'})${where} and re-rendered ${below} unchanged render(s) below: select only what this component needs (a primitive or a shallow-equal selector instead of a new object), or move the subscription into the child that uses it.`
        : `a store or router subscription changed (${hook || 'useSyncExternalStore'})${where}: expected when the data it selects changes. If it renders more often than what it shows changes, select less.`;
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
  /**
   * Estimated JavaScript ms of those renders: the phase's measured JavaScript time
   * times their share of the phase's renders. Only with `timings: true`.
   */
  ms?: number;
}

/** Most expensive first: by estimated ms when both are known, else by renders. */
export function byCost(a: RootCause, b: RootCause): number {
  if (a.ms !== undefined && b.ms !== undefined && a.ms !== b.ms) return b.ms - a.ms;
  return b.renders - a.renders || cmp(a.text, b.text);
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
    if (phase.library?.includes(k)) return true;
    const f = phase.components[k]?.definedIn;
    return f !== undefined && LIBRARY_FILE.test(f);
  };
  const fixable = (c: ComponentReport) => c.avoidableRenders.median + c.callbackRenders.median;
  const out: RootCause[] = [];

  // 1. Props recreated by the same component. Each render is attributed once: a
  // component's fixable renders go to the creators of its recreated props, the
  // creator with the most renders first, never more than the component rendered.
  // Fixable renders already attributed per component, so no render is counted twice.
  const used = new Map<string, number>();
  const budget = (name: string, c: ComponentReport) => fixable(c) - (used.get(name) ?? 0);
  const spend = (name: string, n: number) => used.set(name, (used.get(name) ?? 0) + n);
  const byCreator = new Map<string, { renders: number; props: string[]; affected: string[] }>();
  for (const [name, c] of comps) {
    let left = budget(name, c);
    if (!left) continue;
    const perCreator = new Map<string, { n: number; props: string[] }>();
    for (const [key, n] of Object.entries(c.creators)) {
      const [prop, creator] = key.split('|') as [string, string];
      if (prop === 'children' || libraryKey(creator)) continue;
      const e = perCreator.get(creator) ?? { n: 0, props: [] };
      e.n = Math.max(e.n, n);
      if (!e.props.includes(prop)) e.props.push(prop);
      perCreator.set(creator, e);
    }
    const ranked = [...perCreator].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
    for (const [creator, { n, props }] of ranked) {
      const take = Math.min(n, left);
      if (take <= 0) break;
      left -= take;
      spend(name, take);
      const e = byCreator.get(creator) ?? { renders: 0, props: [], affected: [] };
      e.renders += take;
      for (const p of props) if (!e.props.includes(p)) e.props.push(p);
      if (!e.affected.includes(name)) e.affected.push(name);
      byCreator.set(creator, e);
    }
  }
  for (const [creator, e] of byCreator) {
    const stale = e.props
      .map((prop) =>
        comps
          .map(([, c]) => Object.keys(c.staleMemo).find((k) => k.startsWith(`${prop}|${creator}|`)))
          .find(Boolean),
      )
      .find(Boolean)
      ?.split('|');
    const notMemo = e.affected.filter((k) => !phase.components[k]?.memo && !libraryKey(k));
    const wrap = notMemo.length
      ? `, then wrap ${code(notMemo.slice(0, 2))} in React.memo (stable props alone do not skip renders)`
      : '';
    const fix = stale
      ? `${depFix(`\`${stale[0]}\``, stale[2] ?? '')}${realChange(stale[2] ?? '') ? '' : wrap}`
      : `memoize them there (useCallback / useMemo, or hoist constants)${wrap}`;
    out.push({
      renders: e.renders,
      text: `\`${creator}\` recreates ${code(e.props.slice(0, 3))}${e.props.length > 3 ? ` and ${e.props.length - 3} more` : ''} → ${e.renders} avoidable render(s) in ${code(e.affected.slice(0, 3))}${e.affected.length > 3 ? ` and ${e.affected.length - 3} more` : ''}: ${fix}.`,
    });
  }

  // 2. Context values recreated by the same provider owner.
  const byProvider = new Map<string, { renders: number; affected: string[] }>();
  for (const [name, c] of comps) {
    for (const owner of Object.keys(c.recreatedContextFrom)) {
      if (libraryKey(owner)) continue;
      const take = budget(name, c);
      if (take <= 0) continue;
      spend(name, take);
      const e = byProvider.get(owner) ?? { renders: 0, affected: [] };
      e.renders += take;
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

  // 3. State set in a useEffect right after a render: one extra commit each time.
  // The renders in those commits are not counted again below.
  for (const [name, c] of comps) {
    const effect = effectCascade(c);
    if (!effect.total || libraryKey(name)) continue;
    out.push({
      renders: effect.renders,
      text: `A useEffect in \`${name}\` sets ${effect.states.slice(0, 2).join(', ')}${effect.states.length > 2 ? ' and more' : ''} right after rendering → ${effect.total} extra commit(s), ${effect.renders} render(s): ${effect.fix}.`,
    });
  }

  for (const [name, c] of comps) {
    const n = Math.min(c.inEffectCascades ?? 0, c.wastedRenders.median, budget(name, c));
    if (n > 0) spend(name, n);
  }

  // 4. State updates that re-render unchanged children, with the best React.memo boundary.
  const ownerOf = (c: ComponentReport) => c.locations[0]?.match(/ \((.+)\)$/)?.[1];
  for (const [trigger, t] of comps) {
    if (!t.causes.state || libraryKey(trigger)) continue;
    // Only renders with no other explanation (wasted): recreated props and
    // context values are already listed above as their own root causes.
    const share = new Map<string, number>();
    for (const [k, c] of comps) {
      const n = Math.min(c.triggeredBy[trigger] ?? 0, c.wastedRenders.median, budget(k, c));
      if (n > 0) share.set(k, n);
    }
    const wasted = (k: string) => share.get(k) ?? 0;
    const hit = comps.filter(([k]) => wasted(k) > 0);
    const total = hit.reduce((a, [k]) => a + wasted(k), 0);
    if (total < 3) continue;
    for (const [k, n] of share) spend(k, n);
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
      for (const [k] of hit) if (seen.has(k)) sum += wasted(k);
      return sum;
    };
    const boundary = hit
      .filter(
        // Lowercase names are render functions (e.g. table cell renderers), not memo-able components.
        ([k, c]) =>
          ownerOf(c) === trigger &&
          !libraryKey(k) &&
          !c.memo &&
          c.causes.parent > 0 &&
          // React.memo cannot skip it while it reads a recreated context value,
          // and must not when it reads mutable data (stale output).
          !Object.keys(c.maskedContextFrom ?? {}).length &&
          !c.mutableReads &&
          /^[A-Z]/.test(k),
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

  // With measured CPU, put a cost on each cause (renders are not equally expensive
  // across phases, but within one phase their share is the best estimate we have).
  const js = phase.cost?.scriptMs.median;
  const total = phase.totalRenders.median;
  if (js !== undefined && total > 0) {
    for (const c of out) {
      c.ms = Math.round((js * c.renders) / total);
      if (c.ms > 0) c.text += ` (≈ ${c.ms} ms of JavaScript)`;
    }
  }
  return out.sort(byCost).slice(0, max);
}

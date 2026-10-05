/**
 * Browser-side instrumentation.
 *
 * `installCrispyHook` is serialized with Function#toString and injected with
 * page.addInitScript, so it MUST be fully self-contained: no imports, no
 * references to outer scope, no helpers defined outside of it.
 *
 * It installs (or wraps) `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which every React
 * renderer (dev and prod) notifies on each commit. On every commit we diff the
 * current fiber tree against its alternate the same way React DevTools does and
 * record which components rendered and why.
 */
export function installCrispyHook(): void {
  const w = window as any;
  if (w.__CRISPY__) return;

  // Fiber tags we treat as "components". 14 (MemoComponent) is skipped because
  // its child fiber is the wrapped component and would be counted twice.
  const COMPONENT_TAGS: Record<number, true> = { 0: true, 1: true, 2: true, 11: true, 15: true };
  const PERFORMED_WORK = 1;

  const state: any = {
    reactDetected: false,
    reactVersion: null,
    profilingBuild: false,
    phase: 'load',
    phases: {},
    lastCommitAt: 0,
    /** Total commits since the page loaded; polled by the runner to detect activity. */
    commitCount: 0,
    /** Component names rendered in the most recent commit (for "never settled" warnings). */
    lastCommitNames: [],
    /** Component key -> component function (not serialized; read by the runner via CDP). */
    typeRefs: {},
    /** Component name -> type identities in first-seen order (kept across navigations). */
    identities: {},
    /** Increments on every full navigation; part of root labels. */
    documentIndex: 0,
    vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
  };
  w.__CRISPY__ = state;

  // Full navigations (scenario `goto` steps or app-initiated reloads) create a new
  // document and a fresh hook. Carry the collected data over through sessionStorage
  // so earlier phases are not lost. Each profiling run uses a new browser context,
  // so nothing leaks between runs.
  const STORAGE_KEY = '__crispy_state__';
  // Only the top frame owns the profiling state: same-origin iframes share
  // sessionStorage and would otherwise overwrite it with their own data.
  let isTop = true;
  try {
    isTop = w.top === w;
  } catch {
    isTop = false;
  }
  try {
    const saved = isTop ? sessionStorage.getItem(STORAGE_KEY) : null;
    if (saved) {
      const prev = JSON.parse(saved);
      state.phases = prev.phases;
      state.phase = prev.phase;
      state.profilingBuild = prev.profilingBuild;
      state.vitals = prev.vitals;
      if (prev.hookErrors) state.hookErrors = prev.hookErrors;
      if (prev.identities) state.identities = prev.identities;
      state.documentIndex = (prev.documentIndex || 0) + 1;
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
  w.addEventListener('pagehide', () => {
    if (!isTop) return;
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          phases: state.phases,
          phase: state.phase,
          profilingBuild: state.profilingBuild,
          vitals: state.vitals,
          hookErrors: state.hookErrors,
          identities: state.identities,
          documentIndex: state.documentIndex,
        }),
      );
    } catch {}
  });

  function phaseData(): any {
    let p = state.phases[state.phase];
    if (!p) {
      p = { commits: 0, components: {} };
      state.phases[state.phase] = p;
    }
    return p;
  }

  function nameOf(fiber: any): string {
    const t = fiber.type;
    if (!t) return 'Anonymous';
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    if (typeof t === 'object') {
      const inner = t.render || t.type;
      return (
        t.displayName ||
        (inner && (inner.displayName || inner.name)) ||
        (fiber.tag === 11 ? 'ForwardRef' : 'Anonymous')
      );
    }
    return String(t);
  }

  let currentCommitNames: Record<string, true> = {};

  // Distinct component types that share a display name get distinct keys
  // ("Item", "Item#2", ...) in first-seen order, which is deterministic. Each
  // type is identified by a hash of its source (plus its order among types with
  // identical source, e.g. styled components), and these identities survive full
  // navigations, so `Item#2` means the same component in every document.
  const typeKeys = new WeakMap<object, string>();
  const seenInDocument: Record<string, number> = {};

  function fingerprint(fn: any): string {
    let src = '';
    try {
      src = Function.prototype.toString.call(fn);
    } catch {}
    // FNV-1a: short, deterministic, good enough to tell components apart.
    let h = 0x811c9dc5;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function keyOf(fiber: any): string {
    const t = fiber.type;
    const name = nameOf(fiber);
    if (!t || (typeof t !== 'object' && typeof t !== 'function')) return name;
    let key = typeKeys.get(t);
    if (!key) {
      const fn = typeof t === 'function' ? t : t.render || t.type || t;
      const fp = fingerprint(typeof fn === 'function' ? fn : null);
      const nth = (seenInDocument[`${name}|${fp}`] || 0) + 1;
      seenInDocument[`${name}|${fp}`] = nth;
      if (!state.identities[name]) state.identities[name] = [];
      const ids = state.identities[name];
      let index = ids.indexOf(`${fp}:${nth}`);
      if (index < 0) index = ids.push(`${fp}:${nth}`) - 1;
      key = index === 0 ? name : `${name}#${index + 1}`;
      typeKeys.set(t, key);
      // The runner resolves where each component function is defined (via CDP)
      // to give same-named components stable, source-based identities.
      state.typeRefs[key] = fn;
    }
    return key;
  }

  const JSX_FRAME = /\b(jsxs?|jsxDEV|createElement)\b/;

  /** Parses "at Name (url:line:col)" or "at url:line:col"; urls may contain parentheses. */
  function parseFrame(
    line: string,
  ): { fn: string | null; file: string; line: string; col: string } | null {
    const t = line.trim();
    if (t.indexOf('at ') !== 0) return null;
    let rest = t.slice(3);
    let fn: string | null = null;
    const open = rest.indexOf(' (');
    if (rest.endsWith(')') && open > 0) {
      fn = rest.slice(0, open);
      rest = rest.slice(open + 2, -1);
    }
    const m = rest.match(/^(.*):(\d+):(\d+)$/);
    return m ? { fn, file: m[1] as string, line: m[2] as string, col: m[3] as string } : null;
  }

  function ownerName(fiber: any): string | null {
    const o = fiber._debugOwner;
    if (!o) return null;
    if (o.type !== undefined) return nameOf(o);
    return typeof o.name === 'string' ? o.name : null;
  }

  // Formatting a stack is the expensive part: cache per stack object.
  const locationCache = new WeakMap<object, string | null>();

  /**
   * Where this element was created: "file:line (Owner)". Uses `_debugSource`
   * (React <= 18 with the JSX dev transform) or the frame right after the JSX
   * call in `_debugStack` (React 19 owner stacks); the owner comes from
   * `_debugOwner`. Lines refer to the code the browser runs.
   */
  function locationOf(fiber: any): string | null {
    const owner = ownerName(fiber);
    const suffix = owner ? ` (${owner})` : '';
    const src = fiber._debugSource;
    if (src?.fileName) {
      return `${String(src.fileName)}:${src.lineNumber}:${src.columnNumber ?? 1}${suffix}`;
    }
    const dbg = fiber._debugStack;
    if (!dbg || typeof dbg !== 'object') {
      // React <= 19.0 has no owner stacks: record the owner's key, the runner
      // replaces it with the file where the owner is defined.
      const o = fiber._debugOwner;
      return o && o.type !== undefined && owner ? `@owner:${keyOf(o)}${suffix}` : null;
    }
    if (locationCache.has(dbg)) return locationCache.get(dbg) as string | null;
    let found: string | null = null;
    const stack = dbg.stack;
    if (typeof stack === 'string') {
      const lines = stack.split('\n');
      for (let i = 1; i < lines.length - 1; i++) {
        if (!JSX_FRAME.test(lines[i] as string)) continue;
        const f = parseFrame(lines[i + 1] as string);
        if (f) {
          const who = owner ?? f.fn;
          // Full URL and column: the runner maps it through source maps, then shortens it.
          found = `${f.file}:${f.line}:${f.col}${who ? ` (${who})` : ''}`;
        }
        break;
      }
    }
    locationCache.set(dbg, found);
    return found;
  }

  // Each React root gets a label ("document.order"), so the runner can tell
  // apart roots that only render library code (e.g. a framework dev overlay).
  const rootLabels = new WeakMap<object, string>();
  let rootCount = 0;
  let currentRoot = '';

  function entry(fiber: any): any {
    const comps = phaseData().components;
    const name = keyOf(fiber);
    currentCommitNames[name] = true;
    let e = comps[name];
    if (!e) {
      e = {
        renders: 0,
        mounts: 0,
        updates: 0,
        wastedRenders: 0,
        avoidableRenders: 0,
        changedProps: {},
        unstableProps: {},
        callbackProps: {},
        callbackRenders: 0,
        triggeredBy: {},
        recreatedContextFrom: {},
        stateChanges: {},
        providerAt: {},
        creators: {},
        staleMemo: {},
        effectCascades: {},
        memo: false,
        compiled: false,
        locations: {},
        causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: 0 },
        selfDurationMs: 0,
      };
      comps[name] = e;
    }
    if (!e.roots) e.roots = {};
    e.roots[currentRoot] = 1;
    if (isMemo(fiber)) e.memo = true;
    // React Compiler output keeps its cache in updateQueue.memoCache.
    if (fiber.updateQueue?.memoCache) e.compiled = true;
    const loc = locationOf(fiber);
    if (loc && (e.locations[loc] || Object.keys(e.locations).length < 10)) {
      e.locations[loc] = (e.locations[loc] || 0) + 1;
    }
    return e;
  }

  function addDuration(e: any, fiber: any): void {
    if (typeof fiber.selfBaseDuration === 'number') {
      state.profilingBuild = true;
      e.selfDurationMs += fiber.selfBaseDuration;
    }
  }

  function isEffect(v: any): boolean {
    return v !== null && typeof v === 'object' && 'create' in v && 'tag' in v && 'deps' in v;
  }

  // How two values differ, from least to most significant:
  // 0 = same, 1 = new identity but equal data (certainly avoidable),
  // 2 = new function with the same code (avoidable only if the values it captures
  //     did not change, which cannot be observed), 3 = really changed.
  type Change = 0 | 1 | 2 | 3;
  const SHAPE_DEPTH = 3;
  const MAX_ITEMS = 1000;

  function shape(a: any, b: any, depth: number): Change {
    if (Object.is(a, b)) return 0;
    if (a === null || b === null) return 3;
    const ta = typeof a;
    if (ta !== typeof b) return 3;
    if (ta === 'function') {
      const sa = a.toString();
      // Bound and native functions all stringify the same way: treat as real changes.
      if (sa.indexOf('[native code]') !== -1) return 3;
      return sa === b.toString() ? 2 : 3;
    }
    if (ta !== 'object' || depth <= 0) return 3;
    let worst: Change = 1;
    const merge = (c: Change) => {
      if (c > worst) worst = c;
      return worst === 3;
    };
    if (a.$$typeof || b.$$typeof) {
      if (a.$$typeof !== b.$$typeof || a.type !== b.type || a.key !== b.key) return 3;
      merge(shape(a.props, b.props, depth - 1));
      return worst;
    }
    const pa = Object.getPrototypeOf(a);
    if (pa !== Object.getPrototypeOf(b)) return 3;
    if (a instanceof Date) return a.getTime() === b.getTime() ? 1 : 3;
    if (Array.isArray(a)) {
      if (a.length !== b.length || a.length > MAX_ITEMS) return 3;
      for (let i = 0; i < a.length; i++) if (merge(shape(a[i], b[i], depth - 1))) return 3;
      return worst;
    }
    if (a instanceof Map || a instanceof Set) {
      if (a.size !== b.size || a.size > MAX_ITEMS) return 3;
      const ea = Array.from(a.entries());
      const eb = Array.from(b.entries());
      for (let i = 0; i < ea.length; i++) if (merge(shape(ea[i], eb[i], depth))) return 3;
      return worst;
    }
    // Plain objects and class instances with the same prototype: compare own keys.
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length || ka.length > MAX_ITEMS) return 3;
    for (const k of ka) {
      if (!(k in b)) return 3;
      if (merge(shape(a[k], b[k], depth - 1))) return 3;
    }
    return worst;
  }

  const classify = (a: any, b: any): Change => shape(a, b, SHAPE_DEPTH);

  /** useMemo/useCallback store [value, deps] with no update queue: derived, not state. */
  function isMemoHook(hook: any): boolean {
    const ms = hook.memoizedState;
    return (
      hook.queue == null &&
      Array.isArray(ms) &&
      ms.length === 2 &&
      (ms[1] === null || Array.isArray(ms[1]))
    );
  }

  const PRIMITIVE_HOOKS: Record<string, true> = {
    useState: true,
    useReducer: true,
    useRef: true,
    useMemo: true,
    useCallback: true,
    useEffect: true,
    useLayoutEffect: true,
    useInsertionEffect: true,
    useImperativeHandle: true,
    useSyncExternalStore: true,
    useTransition: true,
    useDeferredValue: true,
    useId: true,
    useOptimistic: true,
    useActionState: true,
    useContext: true,
    use: true,
    useDebugValue: true,
  };
  // Hook calls written in each component's own source, in order, with the
  // variable they are assigned to: `const [query, setQuery] = useState(...)`.
  const sourceCalls = new WeakMap<object, { hook: string; name: string | null }[]>();
  function callsIn(type: any): { hook: string; name: string | null }[] {
    const fn = typeof type === 'function' ? type : type && (type.render || type.type);
    if (!fn || typeof fn !== 'function') return [];
    let calls = sourceCalls.get(fn);
    if (calls) return calls;
    calls = [];
    try {
      const src = Function.prototype.toString.call(fn);
      const re = /\b(use[A-Z]\w*)["']?\]?\)?\s*\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const hook = m[1] as string;
        // Turbopack/webpack import identifiers can be ~200 chars: look back to the statement start.
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        const stmt = before.slice(
          Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'), before.lastIndexOf('}')) + 1,
        );
        const named =
          stmt.match(/(?:const|let|var)\s*\[\s*(\w+)/) ||
          stmt.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:\(0,\s*)?[\w$.[\]"']*$/);
        calls.push({ hook, name: named ? (named[1] as string) : null });
      }
    } catch {}
    sourceCalls.set(fn, calls);
    return calls;
  }

  /** Hook-list nodes each hook type occupies (React 18/19 layout). */
  const HOOK_SLOTS: Record<string, number> = {
    useContext: 0,
    use: 0,
    useDebugValue: 0,
    useFormStatus: 0,
    useSyncExternalStore: 2,
    useTransition: 2,
    useActionState: 3,
    useFormState: 3,
  };
  const slotsOf = (t: string) => (t in HOOK_SLOTS ? (HOOK_SLOTS[t] as number) : 1);
  /** Hooks whose value is state (a change re-renders the component). */
  const STATE_KINDS: Record<string, true> = {
    useState: true,
    useReducer: true,
    useSyncExternalStore: true,
    useTransition: true,
    useActionState: true,
    useFormState: true,
    useOptimistic: true,
    useDeferredValue: true,
  };

  /**
   * Names the state that really changed in a function component, e.g.
   * "`query` (useState)" or "store subscription (useSyncExternalStore) in
   * `useLocation`". Only names what can be told for sure: primitives written
   * before the first or after the last custom hook map to exact list slots;
   * inside custom hooks it names the hook only when there is one candidate.
   */
  function changedStateName(prev: any, next: any): string | null {
    if (next.tag === 1) return 'class state (this.state)';
    let a = prev.memoizedState;
    let b = next.memoizedState;
    if (!a || !b || typeof b !== 'object' || !('next' in b)) return null;
    let index = -1;
    let count = 0;
    for (let i = 0; a && b; i++, a = a.next, b = b.next) {
      count = i + 1;
      if (index >= 0 || isEffect(a.memoizedState) || isMemoHook(b)) continue;
      if (classify(a.memoizedState, b.memoizedState) === 3) index = i;
    }
    if (index < 0) return null;

    // Slot -> hook type, following React's layout.
    const slotType: string[] = [];
    for (const t of next._debugHookTypes || []) {
      for (let k = 0; k < slotsOf(t); k++) slotType.push(k === 0 ? t : `${t}(internal)`);
    }
    const kind = slotType.length === count ? slotType[index] : undefined;
    if (!kind || !STATE_KINDS[kind]) return `state (hook #${index + 1})`;

    const calls = callsIn(next.type);
    const custom = (c: { hook: string }) => !PRIMITIVE_HOOKS[c.hook];
    const label = (c: { hook: string; name: string | null }) =>
      c.name ? `\`${c.name}\` (${c.hook})` : `${c.hook}`;
    // Primitives before the first custom hook occupy the first slots...
    let slot = 0;
    for (const c of calls) {
      if (custom(c)) break;
      const n = slotsOf(c.hook);
      if (index >= slot && index < slot + n) return c.hook === kind ? label(c) : `${kind}`;
      slot += n;
    }
    // ...and primitives after the last custom hook occupy the last ones.
    slot = count;
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i] as { hook: string; name: string | null };
      if (custom(c)) break;
      const n = slotsOf(c.hook);
      if (index >= slot - n && index < slot) return c.hook === kind ? label(c) : `${kind}`;
      slot -= n;
    }
    const owners = calls.filter(custom).map((c) => c.hook);
    const uniq = owners.filter((h, i) => owners.indexOf(h) === i);
    const where = !uniq.length
      ? ''
      : uniq.length === 1
        ? ` in \`${uniq[0]}\``
        : ` in one of ${uniq
            .slice(0, 3)
            .map((h) => `\`${h}\``)
            .join(', ')}`;
    return kind === 'useSyncExternalStore'
      ? `store subscription (useSyncExternalStore)${where}`
      : `${kind}${where}`;
  }

  function stateChange(prev: any, next: any): Change {
    if (next.tag === 1) return classify(prev.memoizedState, next.memoizedState);
    let a = prev.memoizedState;
    let b = next.memoizedState;
    // Function components: memoizedState is a linked list of hooks.
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return classify(a, b);
    }
    if (!('next' in b)) return classify(a, b);
    let worst: Change = 0;
    while (a && b) {
      const av = a.memoizedState;
      const bv = b.memoizedState;
      if (!(isEffect(av) && isEffect(bv)) && !isMemoHook(b)) {
        const c = classify(av, bv);
        if (c > worst) worst = c;
        if (worst === 3) return 3;
      }
      a = a.next;
      b = b.next;
    }
    return a !== b ? 3 : worst;
  }

  /** Contexts whose value was recreated with equal content (filled by contextChange). */
  let recreatedContexts: any[] = [];

  function contextChange(prev: any, next: any): Change {
    let a = prev.dependencies?.firstContext;
    let b = next.dependencies?.firstContext;
    let worst: Change = 0;
    recreatedContexts = [];
    while (a && b) {
      const c = classify(a.memoizedValue, b.memoizedValue);
      if (c === 1 || c === 2) recreatedContexts.push(b.context);
      if (c > worst) worst = c;
      if (worst === 3) return 3;
      a = a.next;
      b = b.next;
    }
    return worst;
  }

  /** Name of the component that renders the provider of `context` above `fiber`. */
  function providerOwner(
    fiber: any,
    context: any,
  ): { owner: string; at: string | null; provider: any } | null {
    let f = fiber.return;
    while (f) {
      // ContextProvider fiber: type is the context (React 19) or {_context} (<= 18).
      if (f.tag === 10 && (f.type === context || f.type?._context === context)) {
        const at = locationOf(f);
        const owner = ownerName(f);
        if (owner) return { owner, at, provider: f };
        let up = f.return;
        while (up && !COMPONENT_TAGS[up.tag]) up = up.return;
        return up ? { owner: nameOf(up), at, provider: f } : null;
      }
      f = f.return;
    }
    return null;
  }

  /** The component that created `value`, skipping owners that received it as a prop. */
  function creatorOf(fiber: any, value: any): any {
    let owner = fiber._debugOwner;
    for (let i = 0; owner && owner.type !== undefined && i < 20; i++) {
      const props = owner.memoizedProps;
      let forwarded = false;
      if (props && typeof props === 'object') {
        for (const k in props) {
          if (props[k] === value) {
            forwarded = true;
            break;
          }
        }
      }
      if (!forwarded) return COMPONENT_TAGS[owner.tag] ? owner : null;
      owner = owner._debugOwner;
    }
    return null;
  }

  const kindOf = (v: any) =>
    typeof v === 'function'
      ? 'a function'
      : Array.isArray(v)
        ? 'an array'
        : v && typeof v === 'object'
          ? 'an object'
          : typeof v;

  /**
   * When `value` is the result of a useCallback/useMemo in `owner`: the
   * dependencies that changed, e.g. "#2 (an object)" (1-based), or "" when the
   * hook has no dependency list. null when the value is not memoized there.
   */
  // Dependency-list names of each useCallback/useMemo in a component's source, in
  // order ([["cart"], ["query", "page"]]), cached per function. Rough parsing:
  // used only when the count matches the component's memo hooks.
  const memoDepNames = new WeakMap<object, string[][]>();
  function depNamesOf(fn: any): string[][] {
    if (!fn || typeof fn !== 'function') return [];
    let cached = memoDepNames.get(fn);
    if (cached) return cached;
    cached = [];
    try {
      const src = Function.prototype.toString.call(fn);
      const re = /\b(useCallback|useMemo)["']?\]?\)?\s*\(/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        // Find the matching ")" of the call, then the last top-level [...] inside it.
        let depth = 0;
        let end = -1;
        let lastOpen = -1;
        let lastClose = -1;
        let quote = '';
        for (let i = m.index + m[0].length - 1; i < src.length; i++) {
          const ch = src[i] as string;
          if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = '';
            continue;
          }
          if (ch === '"' || ch === "'" || ch === '`') quote = ch;
          else if (ch === '(' || ch === '{' || ch === '[') {
            if (depth === 1 && ch === '[') lastOpen = i;
            depth++;
          } else if (ch === ')' || ch === '}' || ch === ']') {
            depth--;
            if (depth === 1 && ch === ']') lastClose = i;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        const names =
          end > 0 &&
          lastOpen > 0 &&
          lastClose > lastOpen &&
          !/\S/.test(src.slice(lastClose + 1, end).replace(/,/g, ''))
            ? src
                .slice(lastOpen + 1, lastClose)
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            : [];
        cached.push(names);
      }
    } catch {}
    memoDepNames.set(fn, cached);
    return cached;
  }

  function changedMemoDeps(owner: any, value: any): string | null {
    let h = owner.memoizedState;
    let old = owner.alternate ? owner.alternate.memoizedState : null;
    let memoCount = 0;
    for (let a = h; a && typeof a === 'object' && 'next' in a; a = a.next)
      if (isMemoHook(a)) memoCount++;
    let memoIndex = 0;
    for (let i = 0; h && typeof h === 'object' && 'next' in h && i < 200; i++) {
      if (isMemoHook(h) && h.memoizedState[0] === value) {
        const deps = h.memoizedState[1];
        const prevDeps = old && isMemoHook(old) ? old.memoizedState[1] : null;
        if (!deps || !prevDeps) return '';
        const fn = owner.type && (owner.type.render || owner.type);
        const all = depNamesOf(fn);
        const names = all.length === memoCount ? all[memoIndex] || [] : [];
        const named = names.length === deps.length && names.every((n) => /^[\w$.]+$/.test(n));
        const out: string[] = [];
        for (let d = 0; d < deps.length; d++) {
          if (!Object.is(deps[d], prevDeps[d]))
            out.push(`${named ? `\`${names[d]}\`` : `#${d + 1}`} (${kindOf(deps[d])})`);
        }
        return out.join(', ');
      }
      if (isMemoHook(h)) memoIndex++;
      h = h.next;
      old = old ? old.next : null;
    }
    return null;
  }

  function isMemo(fiber: any): boolean {
    return fiber.tag === 15 || fiber.return?.tag === 14;
  }

  /** Changed prop keys, split by how they changed. */
  function propChanges(
    prev: any,
    next: any,
  ): { changed: string[]; unstable: string[]; callbacks: string[] } {
    const pp = prev.memoizedProps;
    const np = next.memoizedProps;
    const out = { changed: [] as string[], unstable: [] as string[], callbacks: [] as string[] };
    if (pp === np) return out;
    if (!pp || !np || typeof pp !== 'object' || typeof np !== 'object') {
      out.changed.push('(props)');
      return out;
    }
    const seen: Record<string, true> = {};
    for (const k in np) {
      seen[k] = true;
      const c = classify(pp[k], np[k]);
      if (c === 1) out.unstable.push(k);
      else if (c === 2) out.callbacks.push(k);
      else if (c === 3) out.changed.push(k);
    }
    for (const k in pp) if (!seen[k]) out.changed.push(k);
    return out;
  }

  function recordMount(fiber: any): void {
    if (!COMPONENT_TAGS[fiber.tag]) return;
    const e = entry(fiber);
    commitRenders++;
    commitRenderKeys.push(e);
    currentMountSet.add(fiber);
    e.renders++;
    e.mounts++;
    addDuration(e, fiber);
  }

  /**
   * Records an update. `trigger` is the nearest ancestor whose own state really
   * changed in this commit (the root cause of a cascade). Returns true when this
   * component is itself a trigger.
   */
  function recordUpdate(prev: any, next: any, trigger: string | null): boolean {
    const e = entry(next);
    e.renders++;
    e.updates++;
    commitRenders++;
    commitRenderKeys.push(e);
    if (firedPassive(next)) currentFirers.push(next);
    addDuration(e, next);
    const p = propChanges(prev, next);
    const s = stateChange(prev, next);
    const raw = contextChange(prev, next);
    // A parent that creates a new element re-renders a non-memo child anyway: a
    // recreated context value is then not the reason, the parent is.
    const forced = !isMemo(next) && prev.memoizedProps !== next.memoizedProps;
    const c = forced && raw !== 3 ? 0 : raw;
    const bump = (map: any, keys: string[]) => {
      for (const k of keys) map[k] = (map[k] || 0) + 1;
    };
    bump(e.changedProps, p.changed);
    bump(e.changedProps, p.unstable);
    bump(e.changedProps, p.callbacks);
    bump(e.unstableProps, p.unstable);
    bump(e.callbackProps, p.callbacks);
    if (p.changed.length) e.causes.props++;
    let what: string | null = null;
    if (s === 3) {
      e.causes.state++;
      what = changedStateName(prev, next);
      if (what) e.stateChanges[what] = (e.stateChanges[what] || 0) + 1;
    }
    if (c === 3) e.causes.context++;
    if (s === 3) {
      if (cascadeCommit) cascadeOwners.push({ fiber: next, key: keyOf(next), what });
      return true;
    }
    if (trigger) e.triggeredBy[trigger] = (e.triggeredBy[trigger] || 0) + 1;
    for (const ctx of c ? recreatedContexts : []) {
      const found = providerOwner(next, ctx);
      if (!found) continue;
      e.recreatedContextFrom[found.owner] = (e.recreatedContextFrom[found.owner] || 0) + 1;
      if (found.at) e.providerAt[found.at] = (e.providerAt[found.at] || 0) + 1;
      // The value may already be memoized, with dependencies that change.
      const ownerFiber = found.provider._debugOwner;
      const value = found.provider.memoizedProps?.value;
      if (ownerFiber && ownerFiber.type !== undefined && COMPONENT_TAGS[ownerFiber.tag]) {
        const deps = changedMemoDeps(ownerFiber, value);
        if (deps) {
          const id = `(context value)|${keyOf(ownerFiber)}|${deps}`;
          e.staleMemo[id] = (e.staleMemo[id] || 0) + 1;
        }
      }
    }
    // For recreated props: which component created the value (owners that only
    // forwarded it are skipped), and whether it came from a useCallback/useMemo
    // whose dependencies changed.
    for (const k of p.unstable.concat(p.callbacks)) {
      const value = next.memoizedProps[k];
      const creator = creatorOf(next, value);
      if (!creator) continue;
      const by = `${k}|${keyOf(creator)}`;
      e.creators[by] = (e.creators[by] || 0) + 1;
      const deps = changedMemoDeps(creator, value);
      if (deps) {
        const id = `${by}|${deps}`;
        e.staleMemo[id] = (e.staleMemo[id] || 0) + 1;
      }
    }
    if (p.changed.length > 0 || c === 3) return false;
    // Nothing really changed. Recreated callbacks are reported separately: they
    // are avoidable only if the values they capture did not change.
    if (p.callbacks.length > 0 || s === 2 || c === 2) {
      e.causes.callback++;
      e.callbackRenders++;
    } else if (p.unstable.length > 0 || s === 1 || c === 1) {
      e.causes.unstable++;
      e.avoidableRenders++;
    } else {
      e.causes.parent++;
      e.wastedRenders++;
      e.avoidableRenders++;
    }
    return false;
  }

  // Unusual fiber shapes must not lose the whole run: count the failure, keep the
  // first message, skip that one component and keep walking.
  function noteError(err: unknown): void {
    state.hookErrors = state.hookErrors || { count: 0, first: String(err) };
    state.hookErrors.count++;
  }

  function mountSubtree(fiber: any): void {
    try {
      recordMount(fiber);
    } catch (err) {
      noteError(err);
    }
    let child = fiber.child;
    while (child) {
      mountSubtree(child);
      child = child.sibling;
    }
  }

  function didRender(next: any): boolean {
    const flags = next.flags !== undefined ? next.flags : next.effectTag;
    return (flags & PERFORMED_WORK) === PERFORMED_WORK;
  }

  /** React.memo saved a render: the parent rendered, this memo component did not. */
  function memoSkip(fiber: any): void {
    try {
      const p = phaseData();
      if (!p.memoSkips) p.memoSkips = {};
      const k = keyOf(fiber);
      p.memoSkips[k] = (p.memoSkips[k] || 0) + 1;
    } catch (err) {
      noteError(err);
    }
  }

  function updateSubtree(
    next: any,
    prev: any,
    trigger: string | null,
    parentRendered = false,
  ): void {
    let below = trigger;
    const isComponent = COMPONENT_TAGS[next.tag];
    const rendered = isComponent && didRender(next);
    if (parentRendered) {
      if (next.tag === 15 && !rendered) memoSkip(next);
      else if (
        next.tag === 14 &&
        next.child &&
        (next.child === prev.child || !didRender(next.child))
      )
        memoSkip(next.child);
    }
    if (rendered) {
      try {
        if (recordUpdate(prev, next, trigger)) below = keyOf(next);
      } catch (err) {
        noteError(err);
      }
    }
    if (next.child === prev.child) return; // whole subtree bailed out
    // Host elements pass their parent component's "rendered" down.
    const passDown = isComponent ? rendered : parentRendered;
    let child = next.child;
    while (child) {
      if (child.alternate) updateSubtree(child, child.alternate, below, passDown);
      else mountSubtree(child);
      child = child.sibling;
    }
  }

  // Roots seen so far, to know whether React still has work it has not committed
  // (interrupted concurrent renders, transitions, deferred values).
  const roots = new Set<any>();
  // Idle, offscreen and deferred lanes may stay pending by design; ignore them.
  const ACTIVE_LANES = (1 << 27) - 1;
  state.hasPendingWork = (): boolean => {
    for (const r of roots) {
      if ((r.pendingLanes & ACTIVE_LANES) !== 0) return true;
    }
    return false;
  };

  /**
   * Effect cascades. A passive effect that sets state schedules a DefaultLane
   * update, which is already pending when React reports the commit (React 19
   * flushes effects of discrete updates first) or right after the effects ran
   * (onPostCommitFiberRoot, React 18). The next commit of that root is then
   * attributed to the components whose passive effects ran in the previous
   * commit: the owner of the state when its own effect ran, else the child whose
   * effect ran (a setter passed as a prop); a store change goes to the only effect
   * that ran. Layout effects (SyncLane: measuring the DOM),
   * transitions and deferred values use other lanes; effects of components that
   * just mounted, legacy roots and React <= 17 are skipped.
   */
  // React 19 added SyncHydrationLane, shifting the lanes: DefaultLane is 16 in
  // React 18 and 32 in 19. Store updates (useSyncExternalStore) always use SyncLane.
  function laneBits(): { sync: number; def: number } | null {
    const major = Number.parseInt(String(state.reactVersion || ''), 10);
    if (major === 18) return { sync: 1, def: 16 };
    if (major >= 19) return { sync: 2, def: 32 };
    return null;
  }
  const HOOK_HAS_EFFECT = 1;
  const HOOK_PASSIVE = 8;
  /** Root -> lanes left pending right after its last commit or its effects. */
  const cascadeNext = new WeakMap<object, number>();
  let cascadeCommit = 0;
  let cascadeOwners: { fiber: any; key: string; what: string | null }[] = [];
  let commitRenders = 0;
  /** Entries of the renders in this commit (one per render). */
  let commitRenderKeys: any[] = [];
  let currentFirers: any[] = [];
  const firersByRoot = new WeakMap<object, any[]>();
  let currentMountSet = new WeakSet<object>();
  const mountsByRoot = new WeakMap<object, WeakSet<object>>();
  // Timers and input between a commit and its deferred effects can schedule the
  // same lane: then the next commit is not only the effects' work.
  let outsideEvents = 0;
  const outsideAtCommit = new WeakMap<object, number>();
  for (const t of ['pointerdown', 'keydown', 'input', 'change', 'submit', 'wheel', 'message']) {
    try {
      w.addEventListener(t, () => outsideEvents++, true);
    } catch {}
  }
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame']) {
    const original = w[name];
    if (typeof original !== 'function') continue;
    w[name] = function (this: any, cb: any, ...rest: any[]) {
      const wrapped =
        typeof cb === 'function'
          ? function (this: any, ...args: any[]) {
              outsideEvents++;
              return cb.apply(this, args);
            }
          : cb;
      return original.call(this, wrapped, ...rest);
    };
  }

  /** A passive effect of this function component ran in this commit (deps changed). */
  function firedPassive(fiber: any): boolean {
    const last = fiber.updateQueue?.lastEffect;
    if (!last?.next) return false;
    const first = last.next;
    let e = first;
    do {
      if ((e.tag & (HOOK_HAS_EFFECT | HOOK_PASSIVE)) === (HOOK_HAS_EFFECT | HOOK_PASSIVE))
        return true;
      e = e.next;
    } while (e && e !== first);
    return false;
  }

  const same = (a: any, b: any) => a === b || a === b.alternate;
  function inside(fiber: any, ancestor: any): boolean {
    for (let x = fiber; x; x = x.return) if (same(x, ancestor)) return true;
    return false;
  }

  /** Attributes the state changes of a flagged commit to the effects that set them. */
  function blameCascade(firers: any[], mounted: WeakSet<object> | undefined): void {
    const bits = laneBits();
    if (!firers.length || !bits) return;
    const viaState = (cascadeCommit & bits.def) !== 0;
    const hits: { fiber: any; label: string }[] = [];
    let store = false;
    for (const o of cascadeOwners) {
      // Effects of a component that just mounted ("mounted" flags, SSR) are expected.
      if (
        mounted &&
        (mounted.has(o.fiber) || (o.fiber.alternate && mounted.has(o.fiber.alternate)))
      )
        continue;
      const what = o.what || 'state';
      // A store write is SyncLane; other state set in a passive effect is DefaultLane
      // (SyncLane there comes from layout effects, which may measure the DOM).
      if (what.indexOf('useSyncExternalStore') >= 0) {
        // Any effect may have written the store: only blame when one effect ran.
        if (!store && firers.length === 1)
          hits.push({ fiber: firers[0], label: `a store read by \`${o.key}\`` });
        store = true;
        continue;
      }
      if (!viaState) continue;
      const own = firers.filter((f) => same(f, o.fiber));
      if (own.length) {
        hits.push({ fiber: own[0], label: what });
        continue;
      }
      // A child's effect calling a setter it got as a prop. Nothing else is guessed:
      // events crispy cannot see (e.g. an image loading) may have set the state.
      const below = firers.filter((f) => inside(f, o.fiber));
      if (below.length === 1)
        hits.push({ fiber: below[0], label: `${what} in \`${o.key}\` (via a prop)` });
    }
    // Renders in an extra commit are not also another root cause's (React.memo advice).
    if (hits.length)
      for (const e of commitRenderKeys) e.inEffectCascades = (e.inEffectCascades || 0) + 1;
    const counted = new Set<string>();
    for (const h of hits) {
      const key = keyOf(h.fiber);
      const e = phaseData().components[key] || entry(h.fiber);
      if (!e.effectCascades) e.effectCascades = {};
      e.effectCascades[h.label] = (e.effectCascades[h.label] || 0) + 1;
      if (!counted.has(key)) {
        counted.add(key);
        e.cascadeCommits = (e.cascadeCommits || 0) + 1;
        e.cascadeRenders = (e.cascadeRenders || 0) + commitRenders;
      }
    }
  }

  function onPostCommit(root: any): void {
    try {
      const bits = laneBits();
      if (!bits || !root || root.tag !== 1 || outsideAtCommit.get(root) !== outsideEvents) return;
      const pending = root.pendingLanes & (bits.sync | bits.def);
      if (pending) cascadeNext.set(root, (cascadeNext.get(root) || 0) | pending);
    } catch (err) {
      noteError(err);
    }
  }

  function onCommit(root: any): void {
    roots.add(root);
    // Concurrent roots only (createRoot): legacy roots and React <= 17 use other lanes.
    const concurrent = root.tag === 1;
    cascadeCommit = concurrent ? cascadeNext.get(root) || 0 : 0;
    cascadeNext.delete(root);
    cascadeOwners = [];
    currentFirers = [];
    currentMountSet = new WeakSet<object>();
    commitRenders = 0;
    commitRenderKeys = [];
    try {
      const current = root.current;
      const prev = current.alternate;
      phaseData().commits++;
      state.commitCount++;
      state.lastCommitAt = performance.now();
      currentCommitNames = {};
      let label = rootLabels.get(root);
      if (!label) {
        label = `${state.documentIndex}.${++rootCount}`;
        rootLabels.set(root, label);
      }
      currentRoot = label;
      const wasMounted = prev && prev.memoizedState && prev.memoizedState.element != null;
      const isMounted = current.memoizedState && current.memoizedState.element != null;
      if (!isMounted) return;
      if (!wasMounted) {
        let child = current.child;
        while (child) {
          mountSubtree(child);
          child = child.sibling;
        }
      } else {
        updateSubtree(current, prev, null);
      }
      if (cascadeCommit) blameCascade(firersByRoot.get(root) || [], mountsByRoot.get(root));
      firersByRoot.set(root, currentFirers);
      mountsByRoot.set(root, currentMountSet);
      outsideAtCommit.set(root, outsideEvents);
      const bits = laneBits();
      const pending = bits && concurrent ? root.pendingLanes & (bits.sync | bits.def) : 0;
      if (pending) cascadeNext.set(root, pending);
      state.lastCommitNames = Object.keys(currentCommitNames).sort();
      // Which components each commit rendered, so commits can be counted after
      // framework internals are filtered out (deduplicated by component set).
      if (state.lastCommitNames.length) {
        const p = phaseData();
        if (!p.commitKeys) p.commitKeys = {};
        const sig = state.lastCommitNames.join('\n');
        p.commitKeys[sig] = (p.commitKeys[sig] || 0) + 1;
      }
    } catch (err) {
      noteError(err);
    }
  }

  const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && typeof existing.onCommitFiberRoot === 'function') {
    const original = existing.onCommitFiberRoot;
    const originalSchedule = existing.onScheduleFiberRoot;
    existing.onScheduleFiberRoot = function (id: any, root: any, ...rest: any[]) {
      if (root) roots.add(root);
      return originalSchedule?.call(this, id, root, ...rest);
    };
    existing.onCommitFiberRoot = function (id: any, root: any, ...rest: any[]) {
      onCommit(root);
      return original.call(this, id, root, ...rest);
    };
    const originalPost = existing.onPostCommitFiberRoot;
    existing.onPostCommitFiberRoot = function (id: any, root: any, ...rest: any[]) {
      onPostCommit(root);
      return originalPost?.call(this, id, root, ...rest);
    };
    const originalInject = existing.inject;
    existing.inject = function (renderer: any) {
      state.reactDetected = true;
      state.reactVersion = renderer?.version ?? null;
      return originalInject.call(this, renderer);
    };
  } else {
    let nextId = 0;
    const renderers = new Map();
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: any) {
        const id = ++nextId;
        renderers.set(id, renderer);
        state.reactDetected = true;
        state.reactVersion = renderer?.version ?? null;
        return id;
      },
      onCommitFiberRoot(_id: any, root: any) {
        onCommit(root);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot(_id: any, root: any) {
        onPostCommit(root);
      },
      onScheduleFiberRoot(_id: any, root: any) {
        if (root) roots.add(root);
      },
      setStrictMode() {},
      checkDCE() {},
    };
  }

  // Page-level vitals (best effort; unsupported entry types are ignored).
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) state.vitals.lcpMs = Math.round(last.startTime * 100) / 100;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (!e.hadRecentInput) state.vitals.cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.vitals.longTasks++;
        state.vitals.totalBlockingMs += Math.max(0, e.duration - 50);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
}

/**
 * Source injected into the page. Transpilers with keepNames (tsx, some bundlers)
 * rewrite functions to call a `__name` helper that does not exist in the page,
 * so we provide a no-op one.
 */
export function crispyHookSource(): string {
  return `(() => { const __name = (f) => f; (${installCrispyHook.toString()})(); })();`;
}

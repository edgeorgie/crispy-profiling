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
    if (!dbg || typeof dbg !== 'object') return null;
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
        memo: false,
        locations: {},
        causes: { props: 0, state: 0, context: 0, unstable: 0, callback: 0, parent: 0 },
        selfDurationMs: 0,
      };
      comps[name] = e;
    }
    if (!e.roots) e.roots = {};
    e.roots[currentRoot] = 1;
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
  function providerOwner(fiber: any, context: any): string | null {
    let f = fiber.return;
    while (f) {
      // ContextProvider fiber: type is the context (React 19) or {_context} (<= 18).
      if (f.tag === 10 && (f.type === context || f.type?._context === context)) {
        const owner = ownerName(f);
        if (owner) return owner;
        let up = f.return;
        while (up && !COMPONENT_TAGS[up.tag]) up = up.return;
        return up ? nameOf(up) : null;
      }
      f = f.return;
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
    if (isMemo(next)) e.memo = true;
    e.renders++;
    e.updates++;
    addDuration(e, next);
    const p = propChanges(prev, next);
    const s = stateChange(prev, next);
    const c = contextChange(prev, next);
    const bump = (map: any, keys: string[]) => {
      for (const k of keys) map[k] = (map[k] || 0) + 1;
    };
    bump(e.changedProps, p.changed);
    bump(e.changedProps, p.unstable);
    bump(e.changedProps, p.callbacks);
    bump(e.unstableProps, p.unstable);
    bump(e.callbackProps, p.callbacks);
    if (p.changed.length) e.causes.props++;
    if (s === 3) e.causes.state++;
    if (c === 3) e.causes.context++;
    if (s === 3) return true;
    if (trigger) e.triggeredBy[trigger] = (e.triggeredBy[trigger] || 0) + 1;
    for (const ctx of recreatedContexts) {
      const owner = providerOwner(next, ctx);
      if (owner) e.recreatedContextFrom[owner] = (e.recreatedContextFrom[owner] || 0) + 1;
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

  function updateSubtree(next: any, prev: any, trigger: string | null): void {
    let below = trigger;
    if (COMPONENT_TAGS[next.tag] && didRender(next)) {
      try {
        if (recordUpdate(prev, next, trigger)) below = keyOf(next);
      } catch (err) {
        noteError(err);
      }
    }
    if (next.child === prev.child) return; // whole subtree bailed out
    let child = next.child;
    while (child) {
      if (child.alternate) updateSubtree(child, child.alternate, below);
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

  function onCommit(root: any): void {
    roots.add(root);
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
      onPostCommitFiberRoot() {},
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

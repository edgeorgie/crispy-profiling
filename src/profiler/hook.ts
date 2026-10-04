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
    vitals: { lcpMs: null, cls: 0, longTasks: 0, totalBlockingMs: 0 },
  };
  w.__CRISPY__ = state;

  // Full navigations (scenario `goto` steps or app-initiated reloads) create a new
  // document and a fresh hook. Carry the collected data over through sessionStorage
  // so earlier phases are not lost. Each profiling run uses a new browser context,
  // so nothing leaks between runs.
  const STORAGE_KEY = '__crispy_state__';
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const prev = JSON.parse(saved);
      state.phases = prev.phases;
      state.phase = prev.phase;
      state.profilingBuild = prev.profilingBuild;
      state.vitals = prev.vitals;
      if (prev.error) state.error = prev.error;
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
  w.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          phases: state.phases,
          phase: state.phase,
          profilingBuild: state.profilingBuild,
          vitals: state.vitals,
          error: state.error,
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

  function entry(fiber: any): any {
    const comps = phaseData().components;
    const name = nameOf(fiber);
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
        causes: { props: 0, state: 0, context: 0, unstable: 0, parent: 0 },
        selfDurationMs: 0,
      };
      comps[name] = e;
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

  /**
   * True when two values differ only by identity: functions with the same source
   * (a recreated inline callback), or arrays / plain objects / React elements with
   * structurally equal contents. Bounded depth and size keep it cheap.
   */
  function sameShape(a: any, b: any, depth: number): boolean {
    if (Object.is(a, b)) return true;
    if (depth <= 0 || a === null || b === null) return false;
    const ta = typeof a;
    if (ta !== typeof b) return false;
    if (ta === 'function') return a.toString() === b.toString();
    if (ta !== 'object') return false;
    if (a.$$typeof || b.$$typeof) {
      return (
        a.$$typeof === b.$$typeof &&
        a.type === b.type &&
        a.key === b.key &&
        sameShape(a.props, b.props, depth - 1)
      );
    }
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length || a.length > 50) return false;
      for (let i = 0; i < a.length; i++) if (!sameShape(a[i], b[i], depth - 1)) return false;
      return true;
    }
    const pa = Object.getPrototypeOf(a);
    if ((pa !== Object.prototype && pa !== null) || Object.getPrototypeOf(b) !== pa) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length || ka.length > 50) return false;
    for (const k of ka) if (!(k in b) || !sameShape(a[k], b[k], depth - 1)) return false;
    return true;
  }

  const SHAPE_DEPTH = 3;
  // 0 = unchanged, 1 = changed by identity only (avoidable), 2 = really changed
  type Change = 0 | 1 | 2;
  const classify = (a: any, b: any): Change =>
    Object.is(a, b) ? 0 : sameShape(a, b, SHAPE_DEPTH) ? 1 : 2;

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
      if (!(isEffect(av) && isEffect(bv))) {
        const c = classify(av, bv);
        if (c > worst) worst = c;
        if (worst === 2) return 2;
      }
      a = a.next;
      b = b.next;
    }
    return a !== b ? 2 : worst;
  }

  function contextChange(prev: any, next: any): Change {
    let a = prev.dependencies?.firstContext;
    let b = next.dependencies?.firstContext;
    let worst: Change = 0;
    while (a && b) {
      const c = classify(a.memoizedValue, b.memoizedValue);
      if (c > worst) worst = c;
      if (worst === 2) return 2;
      a = a.next;
      b = b.next;
    }
    return worst;
  }

  /** Changed prop keys, split into real changes and identity-only changes. */
  function propChanges(prev: any, next: any): { changed: string[]; unstable: string[] } {
    const pp = prev.memoizedProps;
    const np = next.memoizedProps;
    const out = { changed: [] as string[], unstable: [] as string[] };
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
      else if (c === 2) out.changed.push(k);
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

  function recordUpdate(prev: any, next: any): void {
    const e = entry(next);
    e.renders++;
    e.updates++;
    addDuration(e, next);
    const p = propChanges(prev, next);
    const s = stateChange(prev, next);
    const c = contextChange(prev, next);
    for (const k of p.changed) e.changedProps[k] = (e.changedProps[k] || 0) + 1;
    for (const k of p.unstable) {
      e.changedProps[k] = (e.changedProps[k] || 0) + 1;
      e.unstableProps[k] = (e.unstableProps[k] || 0) + 1;
    }
    if (p.changed.length) e.causes.props++;
    if (s === 2) e.causes.state++;
    if (c === 2) e.causes.context++;
    const real = p.changed.length > 0 || s === 2 || c === 2;
    const identityOnly = p.unstable.length > 0 || s === 1 || c === 1;
    if (real) return;
    // Nothing really changed: avoidable. Either inputs were recreated with equal
    // contents (unstable references) or nothing changed at all (parent re-render).
    e.avoidableRenders++;
    if (identityOnly) {
      e.causes.unstable++;
    } else {
      e.causes.parent++;
      e.wastedRenders++;
    }
  }

  function mountSubtree(fiber: any): void {
    recordMount(fiber);
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

  function updateSubtree(next: any, prev: any): void {
    if (COMPONENT_TAGS[next.tag] && didRender(next)) recordUpdate(prev, next);
    if (next.child === prev.child) return; // whole subtree bailed out
    let child = next.child;
    while (child) {
      if (child.alternate) updateSubtree(child, child.alternate);
      else mountSubtree(child);
      child = child.sibling;
    }
  }

  function onCommit(root: any): void {
    try {
      const current = root.current;
      const prev = current.alternate;
      phaseData().commits++;
      state.commitCount++;
      state.lastCommitAt = performance.now();
      currentCommitNames = {};
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
        updateSubtree(current, prev);
      }
      state.lastCommitNames = Object.keys(currentCommitNames).sort();
    } catch (err) {
      state.error = String(err);
    }
  }

  const existing = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing && typeof existing.onCommitFiberRoot === 'function') {
    const original = existing.onCommitFiberRoot;
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
      onScheduleFiberRoot() {},
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

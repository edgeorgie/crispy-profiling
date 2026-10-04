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
        changedProps: {},
        causes: { props: 0, state: 0, context: 0, parent: 0 },
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

  function stateChanged(prev: any, next: any): boolean {
    if (next.tag === 1) return prev.memoizedState !== next.memoizedState;
    let a = prev.memoizedState;
    let b = next.memoizedState;
    // Function components: memoizedState is a linked list of hooks.
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a !== b;
    if (!('next' in b)) return a !== b;
    while (a && b) {
      const av = a.memoizedState;
      const bv = b.memoizedState;
      if (av !== bv && !(isEffect(av) && isEffect(bv))) return true;
      a = a.next;
      b = b.next;
    }
    return a !== b;
  }

  function contextChanged(prev: any, next: any): boolean {
    let a = prev.dependencies?.firstContext;
    let b = next.dependencies?.firstContext;
    while (a && b) {
      if (!Object.is(a.memoizedValue, b.memoizedValue)) return true;
      a = a.next;
      b = b.next;
    }
    return false;
  }

  function changedPropKeys(prev: any, next: any): string[] {
    const pp = prev.memoizedProps;
    const np = next.memoizedProps;
    if (pp === np) return [];
    if (!pp || !np || typeof pp !== 'object' || typeof np !== 'object') return ['(props)'];
    const keys: string[] = [];
    const seen: Record<string, true> = {};
    for (const k in np) {
      seen[k] = true;
      if (!Object.is(pp[k], np[k])) keys.push(k);
    }
    for (const k in pp) if (!seen[k]) keys.push(k);
    return keys;
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
    const keys = changedPropKeys(prev, next);
    const s = stateChanged(prev, next);
    const c = contextChanged(prev, next);
    if (keys.length) {
      e.causes.props++;
      for (const k of keys) e.changedProps[k] = (e.changedProps[k] || 0) + 1;
    }
    if (s) e.causes.state++;
    if (c) e.causes.context++;
    if (!keys.length && !s && !c) {
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

// Ground truth for named state causes (red-team round 6). Rendered with ?lab.
import { useReducer, useRef, useState, useSyncExternalStore, useTransition } from 'react';

let ext = 0;
const subs = new Set<() => void>();
const sub = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
const bumpExt = () => {
  ext++;
  for (const f of subs) f();
};
// Like a zustand/redux selector hook: several primitives inside a custom hook.
function useMiniStore<T>(select: (v: number) => T): T {
  const selectRef = useRef(select);
  selectRef.current = select;
  return useSyncExternalStore(sub, () => selectRef.current(ext));
}
function useToggle() {
  const [on, set] = useState(false);
  return [on, () => set((x) => !x)] as const;
}

// A: uSES before useState; the useState changes.
function StoreThenState() {
  const v = useSyncExternalStore(sub, () => ext);
  const [count, setCount] = useState(0);
  return (
    <button id="lab-a" type="button" onClick={() => setCount(count + 1)}>
      A {v} {count}
    </button>
  );
}
// B: useState before uSES; the store changes.
function StateThenStore() {
  const [open] = useState(false);
  const v = useSyncExternalStore(sub, () => ext);
  return (
    <button id="lab-b" type="button" onClick={bumpExt}>
      B {String(open)} {v}
    </button>
  );
}
// C: useTransition then useState.
function TransitionThenState() {
  const [pending] = useTransition();
  const [tab, setTab] = useState('x');
  return (
    <button id="lab-c" type="button" onClick={() => setTab(`${tab}x`)}>
      C {String(pending)} {tab}
    </button>
  );
}
// D: custom store hook, then useReducer changes.
function StoreHookThenReducer() {
  const even = useMiniStore((v) => v % 2 === 0);
  const [n, dispatch] = useReducer((x: number) => x + 1, 0);
  return (
    <button id="lab-d" type="button" onClick={() => dispatch()}>
      D {String(even)} {n}
    </button>
  );
}
// E: custom hook wrapping useState, then local state changes.
function CustomThenState() {
  const [on] = useToggle();
  const [label, setLabel] = useState('e');
  return (
    <button id="lab-e" type="button" onClick={() => setLabel(`${label}e`)}>
      E {String(on)} {label}
    </button>
  );
}
// F: the store changes inside the custom hook.
function StoreHookOnly() {
  const value = useMiniStore((v) => v);
  return <span>F {value}</span>;
}

export function Lab() {
  return (
    <div>
      <StoreThenState />
      <StateThenStore />
      <TransitionThenState />
      <StoreHookThenReducer />
      <CustomThenState />
      <StoreHookOnly />
    </div>
  );
}

// Effect cascades (setState right after a render, in an effect). Rendered with ?cascade.
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  useTransition,
} from 'react';

// Derived state synced in an effect: every click commits twice.
function EffectDerived() {
  const [value, setValue] = useState(1);
  const [doubled, setDoubled] = useState(2);
  useEffect(() => setDoubled(value * 2), [value]);
  return (
    <button id="cascade-effect" type="button" onClick={() => setValue(value + 1)}>
      {value} x2 = {doubled}
    </button>
  );
}

// The same cascade when the first update comes from a timer (effects run later).
function TimerThenEffect() {
  const [value, setValue] = useState(1);
  const [doubled, setDoubled] = useState(2);
  useEffect(() => setDoubled(value * 2), [value]);
  return (
    <button
      id="cascade-async"
      type="button"
      onClick={() => setTimeout(() => setValue(value + 1), 0)}
    >
      {value} x2 = {doubled}
    </button>
  );
}

// "Mounted" flags set by an effect on mount are not counted.
function MountFlag() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <span>{String(mounted)}</span>;
}
function MountToggle() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="cascade-mount" type="button" onClick={() => setOpen(!open)}>
        toggle
      </button>
      {open && <MountFlag />}
    </>
  );
}

// The same in a layout effect.
function LayoutDerived() {
  const [value, setValue] = useState(1);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => setWidth(value * 10), [value]);
  return (
    <button id="cascade-layout" type="button" onClick={() => setValue(value + 1)}>
      {value} w{width}
    </button>
  );
}

// Derived during render: one commit per click (the fix).
function RenderDerived() {
  const [value, setValue] = useState(1);
  const doubled = value * 2;
  return (
    <button id="cascade-none" type="button" onClick={() => setValue(value + 1)}>
      {value} x2 = {doubled}
    </button>
  );
}

// Not cascades: a transition and a deferred value commit twice by design, and
// state set when a timer fires is not caused by the render.
function NotCascades() {
  const [pending, start] = useTransition();
  const [tab, setTab] = useState('a');
  const [text, setText] = useState('');
  const deferred = useDeferredValue(text);
  const [later, setLater] = useState(0);
  return (
    <div>
      <button id="cascade-transition" type="button" onClick={() => start(() => setTab(`${tab}a`))}>
        {String(pending)} {tab}
      </button>
      <button id="cascade-deferred" type="button" onClick={() => setText(`${text}d`)}>
        {deferred}
      </button>
      <button
        id="cascade-timer"
        type="button"
        onClick={() => setTimeout(() => setLater(later + 1), 0)}
      >
        {later}
      </button>
    </div>
  );
}

export function Cascade() {
  return (
    <>
      <EffectDerived />
      <TimerThenEffect />
      <MountToggle />
      <LayoutDerived />
      <RenderDerived />
      <NotCascades />
    </>
  );
}

// Red-team round 8 cases.
// A child's effect calls the parent's setter: the child is the place to fix.
function Doubler({ value, onDouble }: { value: number; onDouble: (n: number) => void }) {
  useEffect(() => onDouble(value * 2), [value, onDouble]);
  return <span>{value}</span>;
}
function ParentOfDoubler() {
  const [value, setValue] = useState(1);
  const [total, setTotal] = useState(2);
  return (
    <div>
      <button id="cascade-prop" type="button" onClick={() => setValue(value + 1)}>
        {total}
      </button>
      <Doubler value={value} onDouble={setTotal} />
    </div>
  );
}

// New rows mount while the existing rows' effects cascade.
function ListRow({ total }: { total: number }) {
  const [label, setLabel] = useState('');
  useEffect(() => setLabel(`of ${total}`), [total]);
  return <li>{label}</li>;
}
function RowList() {
  const [n, setN] = useState(2);
  return (
    <div>
      <button id="cascade-rows" type="button" onClick={() => setN(n + 1)}>
        add
      </button>
      <ul>
        {Array.from({ length: n }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
          <ListRow key={i} total={n} />
        ))}
      </ul>
    </div>
  );
}

// A store (zustand/redux-like) written in an effect.
let storeValue = 0;
const listeners = new Set<() => void>();
const store = {
  get: () => storeValue,
  set: (v: number) => {
    storeValue = v;
    for (const f of listeners) f();
  },
  subscribe: (f: () => void) => {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};
function EffectStoreWriter() {
  const [q, setQ] = useState(0);
  useEffect(() => store.set(q * 2), [q]);
  return (
    <button id="cascade-store" type="button" onClick={() => setQ(q + 1)}>
      {q}
    </button>
  );
}
function EffectStoreReader() {
  const v = useSyncExternalStore(store.subscribe, store.get);
  return <span>{v}</span>;
}

export function CascadeRound8() {
  return (
    <>
      <ParentOfDoubler />
      <RowList />
      <EffectStoreWriter />
      <EffectStoreReader />
    </>
  );
}

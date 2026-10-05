import type { ReactNode } from 'react';
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Cascade } from './Cascade.js';
import { Lab } from './Lab.js';

// Replaced at build time: false = naive implementation, true = optimized one.
declare const __FAST__: boolean;

const ThemeContext = createContext('light');
const items = Array.from({ length: 20 }, (_, i) => ({ id: i, label: `Item ${i}` }));

function Header({ title }: { title: string }) {
  return <h1>{title}</h1>;
}

function ThemedLabel() {
  const theme = useContext(ThemeContext);
  return <span id="theme">{theme}</span>;
}

function RowImpl({
  item,
  onSelect,
}: {
  item: { id: number; label: string };
  onSelect: (id: number) => void;
}) {
  return (
    <li>
      <button type="button" onClick={() => onSelect(item.id)}>
        {item.label}
      </button>
    </li>
  );
}
const Row = __FAST__ ? memo(RowImpl) : RowImpl;
(RowImpl as { displayName?: string }).displayName = 'Row';

function Status({ text, style }: { text: string; style: { color: string } }) {
  return (
    <p id="status" style={style}>
      {text}
    </p>
  );
}
const STATUS_STYLE = { color: 'gray' };

function Ticker() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 100);
    return () => clearInterval(id);
  }, []);
  return <span id="ticker">{n}</span>;
}

// Two different components that share the display name "Item".
const ItemA = function Item() {
  return <span>a</span>;
};
const ItemB = function Item() {
  return <span>b</span>;
};
// Bundlers rename duplicate function names (Item2); displayName restores the clash.
ItemA.displayName = 'Item';
ItemB.displayName = 'Item';

// Receives a callback that cannot be stringified: only crispy's hook touches it,
// which simulates an unexpected value shape without breaking React itself.
function Boom(_: { fn: () => number }) {
  return <span>boom</span>;
}
const unreadableFn = () =>
  Object.assign(() => 1, {
    toString() {
      throw new Error('unreadable fn');
    },
  });

// Concurrent rendering: an expensive list driven by a deferred value.
function SlowCell({ text, i }: { text: string; i: number }) {
  const end = performance.now() + 0.5;
  while (performance.now() < end) {
    // simulate an expensive render
  }
  return <li>{`${text}-${i}`}</li>;
}
const CELLS = Array.from({ length: 200 }, (_, i) => i);
const SlowList = memo(function SlowList({ text }: { text: string }) {
  return (
    <ul>
      {CELLS.map((i) => (
        <SlowCell key={i} text={text} i={i} />
      ))}
    </ul>
  );
});
function Deferred() {
  const [value, setValue] = useState('');
  const deferred = useDeferredValue(value);
  return (
    <>
      <input id="deferred-input" value={value} onChange={(e) => setValue(e.target.value)} />
      <SlowList text={deferred} />
    </>
  );
}

// Classification probes (rendered with ?classify).
function DateProbe(_: { when: Date }) {
  return null;
}
function ListProbe(_: { list: number[] }) {
  return null;
}
function BoundProbe(_: { onPick: () => number }) {
  return null;
}
function pick(n: number) {
  return n;
}
function Derived({ n }: { n: number }) {
  const doubled = useMemo(() => n * 2, [n]);
  return <i>{doubled}</i>;
}

// Memo probes (rendered with ?memo): one memo never helps (its prop changes on
// every click), the other always skips.
function CounterView({ n }: { n: number }) {
  return <i>{n}</i>;
}
const UselessMemo = memo(CounterView);
function LabelView({ text }: { text: string }) {
  return <i>{text}</i>;
}
const UsefulMemo = memo(LabelView);

// Store probe (rendered with ?store): a subscription through a custom hook,
// like Redux/Zustand selectors or router location hooks.
let storeValue = 0;
const listeners = new Set<() => void>();
const store = {
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => storeValue,
  bump: () => {
    storeValue++;
    for (const l of listeners) l();
  },
};
function useCounterStore() {
  return useSyncExternalStore(store.subscribe, store.get);
}
function StoreReader() {
  const n = useCounterStore();
  return (
    <button id="store-bump" type="button" onClick={store.bump}>
      store {n}
    </button>
  );
}

// Step probes (rendered with ?steps): a <select> and a pointer-driven slider.
function Picker() {
  const [v, setV] = useState('a');
  return (
    <select id="pick" value={v} onChange={(e) => setV(e.target.value)}>
      <option value="a">A</option>
      <option value="b">B</option>
    </select>
  );
}
function Slider() {
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      id="slider"
      style={{ width: 200, height: 20, background: '#ddd' }}
      onPointerDown={() => setDragging(true)}
      onPointerUp={() => setDragging(false)}
      onPointerMove={(e) => dragging && setX(Math.round(e.clientX))}
    >
      {x}
    </div>
  );
}

// Context value probes (rendered with ?ctxvalue).
const CartContext = createContext({ count: 0, add: () => {} });
function CartBadge() {
  const { count } = useContext(CartContext);
  return <b>{count}</b>;
}
const MemoBox = memo(function Swatch(_: { style: { color: string } }) {
  return null;
});
function CartProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  // Unrelated state: re-renders the provider (and recreates its value) without
  // re-creating `children`, so consumers re-render only because of the context.
  const [, setBump] = useState(0);
  return (
    <CartContext.Provider value={{ count, add: () => setCount((c) => c + 1) }}>
      <button id="cart-bump" type="button" onClick={() => setBump((b) => b + 1)}>
        bump
      </button>
      {children}
    </CartContext.Provider>
  );
}
function CartShell({ tick }: { tick: number }) {
  return (
    <CartProvider>
      <CartBadge />
      <MemoBox style={{ color: tick >= 0 ? 'red' : 'blue' }} />
    </CartProvider>
  );
}

function App() {
  const [data, setData] = useState('none');
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('idle');
  const [theme, setTheme] = useState('light');
  const [, setSelected] = useState<number | null>(null);
  const naiveSelect = (id: number) => setSelected(id);
  const stableSelect = useCallback((id: number) => setSelected(id), []);
  const onSelect = __FAST__ ? stableSelect : naiveSelect;

  return (
    <ThemeContext.Provider value={theme}>
      <Header title="Shop" />
      <ThemedLabel />
      <button id="inc" type="button" onClick={() => setCount((c) => c + 1)}>
        count {count}
      </button>
      <Status text={status} style={__FAST__ ? STATUS_STYLE : { color: 'gray' }} />
      <p id="data">{data}</p>
      <button
        id="fetch"
        type="button"
        onClick={() =>
          fetch('/api/slow')
            .then((r) => r.text())
            .then(setData)
        }
      >
        fetch
      </button>
      {location.search.includes('ticker') && <Ticker />}
      {location.search.includes('boom') && <Boom fn={unreadableFn()} />}
      {location.search.includes('deferred') && <Deferred />}
      {location.search.includes('classify') && (
        <>
          <DateProbe when={new Date(0)} />
          <ListProbe list={Array.from({ length: 60 }, (_, i) => i)} />
          <BoundProbe onPick={pick.bind(null, count)} />
          <Derived n={count} />
        </>
      )}
      {location.search.includes('ctxvalue') && <CartShell tick={count} />}
      {location.search.includes('store') && <StoreReader />}
      {location.search.includes('lab') && <Lab />}
      {location.search.includes('cascade') && <Cascade />}
      {location.search.includes('memo') && (
        <>
          <UselessMemo n={count} />
          <UsefulMemo text="static" />
        </>
      )}
      {location.search.includes('steps') && (
        <>
          <Picker />
          <Slider />
        </>
      )}
      {location.search.includes('iframe') && <iframe src="/?child" title="child" />}
      {location.search.includes('dupes') && (
        <>
          <ItemA />
          <ItemB />
        </>
      )}
      <button id="load" type="button" onClick={() => setTimeout(() => setStatus('loaded'), 120)}>
        load
      </button>
      <button
        id="theme-toggle"
        type="button"
        onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
      >
        toggle theme
      </button>
      <ul>
        {items.map((item) => (
          <Row key={item.id} item={item} onSelect={onSelect} />
        ))}
      </ul>
    </ThemeContext.Provider>
  );
}

// ?auth: a login gate (token in localStorage), like apps that need a session.
function Login() {
  const [user, setUser] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (user === 'demo-user') {
          localStorage.setItem('token', user);
          location.reload();
        }
      }}
    >
      <input id="user" value={user} onChange={(e) => setUser(e.target.value)} />
      <button id="login" type="submit">
        sign in
      </button>
    </form>
  );
}
const gated = location.search.includes('auth') && !localStorage.getItem('token');
const mount = () =>
  createRoot(document.getElementById('root') as HTMLElement).render(gated ? <Login /> : <App />);
// ?lateboot: start rendering after async setup, like apps that start a mock service worker first.
if (location.search.includes('lateboot')) setTimeout(mount, 400);
else mount();

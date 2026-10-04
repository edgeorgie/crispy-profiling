import { createContext, memo, useCallback, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

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

function Status({ text }: { text: string }) {
  return <p id="status">{text}</p>;
}

function Ticker() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 100);
    return () => clearInterval(id);
  }, []);
  return <span id="ticker">{n}</span>;
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
      <Status text={status} />
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

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

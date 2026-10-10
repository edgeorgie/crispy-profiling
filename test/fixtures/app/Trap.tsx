// Things crispy scan must never do (red-team round 9). Rendered with ?trap.
import { useState } from 'react';

const post = (what: string) => fetch(`/api/${what}`, { method: 'POST' });
const live = () => {
  const ws = new WebSocket(`ws://${location.host}/live`);
  ws.onopen = () => ws.send('hello');
};

export function Trap() {
  const [n, setN] = useState(0);
  return (
    <main>
      <button type="button" onClick={() => setN(n + 1)}>
        Add item {n}
      </button>
      {[1, 2, 3].map((m) => (
        <button key={m} type="button" onClick={() => setN(n + m)}>
          Member {m}
        </button>
      ))}
      <ul>
        {['row-a', 'row-b'].map((r) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: a clickable row, like many real apps
          <li key={r} style={{ cursor: 'pointer' }} onClick={() => setN(n + 1)}>
            {r}
          </li>
        ))}
      </ul>
      {/* Icon-only buttons on every row (council round 6, newcomer): one of them is clicked. */}
      {[1, 2, 3].map((m) => (
        <button key={`star-${m}`} type="button" onClick={() => setN(n + m)}>
          ☆
        </button>
      ))}
      {/* A table of clickable rows without a short text (council round 6, intermediate). */}
      <table id="orders">
        <tbody>
          {[1, 2, 3, 4, 5].map((r) => (
            <tr key={r} style={{ cursor: 'pointer' }} onClick={() => setN(n + r)}>
              <td>Order {r}</td>
              <td>Customer {r}</td>
              <td>{r * 10} EUR</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Clickable-looking, but no text to click it by: reported as not tried. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: on purpose */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: on purpose */}
      <div style={{ cursor: 'pointer' }} onClick={() => setN(n + 1)}>
        ★
      </div>
      <button type="button" onClick={() => post('eliminar')}>
        Eliminar
      </button>
      <button type="button" onClick={() => post('supprimer')}>
        Supprimer
      </button>
      <button type="button" aria-label="🗑" onClick={() => post('emoji')}>
        🗑
      </button>
      <button type="button" onClick={() => post('save')}>
        Save changes
      </button>
      <button type="button" onClick={live}>
        Send message
      </button>
      <select aria-label="Bulk actions" onChange={() => post('bulk')}>
        <option value="">Choose</option>
        <option value="archive-selected">Archive selected</option>
        <option value="delete">Delete selected</option>
      </select>
      <form
        id="trap-form"
        onSubmit={(e) => {
          e.preventDefault();
          post('form');
        }}
      />
      <button type="submit" form="trap-form">
        Go
      </button>
      <a href="/?bye" aria-label="Sign-out">
        ⎋
      </a>
    </main>
  );
}

// Things crispy scan must never do (red-team round 9). Rendered with ?trap.
import { useState } from 'react';

const post = (what: string) => fetch(`/api/${what}`, { method: 'POST' });

export function Trap() {
  const [n, setN] = useState(0);
  return (
    <main>
      <button type="button" onClick={() => setN(n + 1)}>
        Add item {n}
      </button>
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

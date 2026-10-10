// A table's column definitions (TanStack style): one anonymous render function per column,
// all defined here and all rendered from one place (council round 6: keys must not depend on
// line numbers). Rendered with ?columns.
import { type ComponentType, useState } from 'react';

const columns: { id: string; cell: ComponentType<{ value: number }> }[] = [
  { id: 'a', cell: ({ value }) => <b>{value}</b> },
  { id: 'b', cell: ({ value }) => <i>{value * 2}</i> },
  { id: 'c', cell: ({ value }) => <u>{value + 1}</u> },
];

const flexRender = (Comp: ComponentType<{ value: number }>, value: number) => (
  <Comp value={value} />
);

export function Columns() {
  const [n, setN] = useState(1);
  return (
    <div id="columns">
      <button type="button" id="columns-inc" onClick={() => setN(n + 1)}>
        columns {n}
      </button>
      {columns.map((c) => (
        <span key={c.id}>{flexRender(c.cell, n)}</span>
      ))}
    </div>
  );
}

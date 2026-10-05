// A component that reads a mutable object passed as the same prop (like a TanStack
// table instance): its renders are not avoidable (council round 1). Rendered with ?mutable.
import { useRef, useState } from 'react';

type Table = { page: number; next(): void; reset(): void };

function Pagination({ table }: { table: Table }) {
  return <span id="mutable-page">Page {table.page}</span>;
}

// Gets the same instance but shows nothing that changes in this flow: still never memo it.
function Toolbar({ table }: { table: Table }) {
  return <span>{Object.keys(table).length} actions</span>;
}

function Static({ label }: { label: string }) {
  return <span>{label}</span>;
}

export function Mutable() {
  const table = useRef<Table>({
    page: 1,
    next() {
      this.page++;
    },
    reset() {
      this.page = 1;
    },
  }).current;
  const [, setTick] = useState(0);
  return (
    <div>
      <button
        id="mutable-next"
        type="button"
        onClick={() => {
          table.next();
          setTick((t) => t + 1);
        }}
      >
        next
      </button>
      <Pagination table={table} />
      <Toolbar table={table} />
      <Static label="same" />
    </div>
  );
}

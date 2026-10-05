// Memoized callbacks whose dependencies change (council round 1). Rendered with ?deps.
import { memo, useCallback, useState } from 'react';

const AddButton = memo(function AddButton({ onAdd }: { onAdd: () => void }) {
  return (
    <button id="deps-add" type="button" onClick={onAdd}>
      add
    </button>
  );
});

export function Deps() {
  const [cart, setCart] = useState<number[]>([]);
  const [, setOther] = useState(0);
  const onAdd = useCallback(() => setCart([...cart, cart.length]), [cart]);
  return (
    <div>
      <AddButton onAdd={onAdd} />
      <button id="deps-other" type="button" onClick={() => setOther((n) => n + 1)}>
        {cart.length}
      </button>
    </div>
  );
}

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Item as BannerItem } from './BannerItem.js';
import { Item } from './ListItem.js';

// ?banner adds an unrelated `Item` that renders before the list items.
function App() {
  const [n, setN] = useState(0);
  return (
    <>
      {location.search.includes('banner') && <BannerItem />}
      <button id="inc" type="button" onClick={() => setN((x) => x + 1)}>
        {n}
      </button>
      <ul>
        <Item label="a" />
        <Item label="b" />
      </ul>
    </>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);

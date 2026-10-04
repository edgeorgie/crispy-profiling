declare module 'fake-lib' {
  import type { ReactElement } from 'react';
  export function LibButton(props: { onClick: () => void }): ReactElement;
}

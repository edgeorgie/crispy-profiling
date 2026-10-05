import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts', 'src/playwright.ts'],
    format: ['esm'],
    target: 'node20',
    dts: { entry: ['src/index.ts', 'src/playwright.ts'] },
    clean: false,
    sourcemap: true,
    // keepNames must stay off: the browser hook is serialized with Function#toString.
    keepNames: false,
  },
  {
    // CommonJS build of the Playwright Test integration: most Next.js/CRA test
    // setups load helpers with require().
    entry: { playwright: 'src/playwright.ts' },
    format: ['cjs'],
    target: 'node20',
    dts: false,
    sourcemap: true,
    keepNames: false,
  },
]);

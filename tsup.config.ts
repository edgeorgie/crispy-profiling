import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/playwright.ts'],
  format: ['esm'],
  target: 'node20',
  dts: { entry: ['src/index.ts', 'src/playwright.ts'] },
  clean: true,
  sourcemap: true,
  // keepNames must stay off: the browser hook is serialized with Function#toString.
  keepNames: false,
});

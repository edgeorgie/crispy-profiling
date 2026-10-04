import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  // keepNames must stay off: the browser hook is serialized with Function#toString.
  keepNames: false,
});

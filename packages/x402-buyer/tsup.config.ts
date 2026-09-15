import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'probe/index': 'src/probe/index.ts', 'eip7702/index': 'src/eip7702/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  treeshake: true,
  splitting: false,
});

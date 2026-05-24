import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'security/index': 'src/security/index.ts',
    'extensions/index': 'src/extensions/index.ts',
    'extras/index': 'src/extras/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  treeshake: true,
  splitting: false,
});

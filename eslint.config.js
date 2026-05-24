import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**', '**/*.cjs'],
  },
  ...tseslint.configs.recommended,
  // Type-aware lint pass — scoped to package source + tests so it gets the
  // SDK surface and its tests. Examples have their own tsconfig contexts and
  // are intentionally excluded from typed lint to avoid pinning every
  // example's tsconfig to this lint runner.
  //
  // Uses explicit `project` paths (not `projectService: true`) because each
  // package keeps tests in `tsconfig.test.json` rather than `tsconfig.json` —
  // projectService's auto-discovery only finds `tsconfig.json` files, which
  // wouldn't pick up test files. `tsconfig.test.json` extends `tsconfig.json`
  // and includes both `src/**` and `test/**`, so a single project per package
  // covers both.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['packages/**/src/**/*.ts', 'packages/**/test/**/*.ts'],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: ['./packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Public-surface hygiene — these rules need type info, so they only run on
  // the type-aware pass above (packages/**/src + packages/**/test). The set
  // mirrors what the audit (CODE_REVIEW.md Finding 3) recommended; tests
  // share most of the bar with src but skip the no-non-null-assertion rule
  // because table-driven cases routinely look up fixtures by key.
  {
    files: ['packages/**/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  {
    files: ['packages/**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  // TSDoc quality bar — see AGENTS.md for the principles these rules encode.
  // Goal: prevent regression of the patterns trimmed in the doc audit; not to
  // force every symbol to carry TSDoc. Rules are scoped to package source only.
  {
    files: ['packages/**/src/**/*.ts'],
    plugins: { jsdoc },
    settings: {
      jsdoc: { mode: 'typescript' },
    },
    rules: {
      // Hard errors — these were all clean post-audit; keep them clean.
      'jsdoc/no-types': 'error', // TSDoc on TS shouldn't restate types
      'jsdoc/no-blank-blocks': 'error', // empty /** */ blocks
      'jsdoc/empty-tags': 'error', // @returns with no description, etc.
      // `@typeParam` is the official TSDoc tag for generic type parameters (typedoc renders it natively). The
      // built-in JSDoc tag set the rule defaults to doesn't include it, so list it here alongside `@internal`.
      'jsdoc/check-tag-names': ['error', { definedTags: ['internal', 'typeParam'] }],
      'jsdoc/check-alignment': 'error',
      'jsdoc/multiline-blocks': 'error',
      'jsdoc/no-multi-asterisks': 'error',
      'jsdoc/require-asterisk-prefix': 'error',

      // Warnings — would flag noise that snuck back in but isn't load-bearing.
      'jsdoc/check-param-names': 'warn', // @param name must match actual param
      'jsdoc/no-defaults': 'warn', // don't restate TS default-param values
      'jsdoc/require-hyphen-before-param-description': ['warn', 'always'],
    },
  },
  // Publishable source is the SDK surface — no console output leaks. Throw
  // typed errors instead and let the caller decide. Examples and scripts are
  // unaffected; the audit confirmed all current `console.*` calls live there.
  {
    files: ['packages/**/src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  prettier,
);

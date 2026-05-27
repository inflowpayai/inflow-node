# Tooling

Quick reference for every build/test/release tool the monorepo uses.

## pnpm 11

[pnpm](https://pnpm.io) is the package manager. Pinned in `package.json#packageManager` and managed via Corepack — contributors
get the exact version automatically on first `pnpm` invocation.

Key configuration lives in `pnpm-workspace.yaml`:

- `packages` — workspace globs (`packages/*`, `examples/*`).
- `engineStrict` — fails install when Node is below the `engines.node` floor declared in each `package.json` (currently `>=22.0.0`).
- `publicHoistPattern` — hoists `*types*`, `*eslint*`, `*prettier*` to the workspace root so editor tooling resolves them.
- `allowBuilds` — opt-in list for postinstall scripts (`esbuild`, `msw`, `sharp`). pnpm 10+ blocks every postinstall by default.

pnpm 11 ignores most `.npmrc` settings — the repo's `.npmrc` is reduced to a single `registry=https://registry.npmjs.org/` line.

## Turborepo 2

[Turborepo](https://turbo.build/repo) orchestrates per-package scripts. Configured in `turbo.json`:

- `build` depends on `^build` (downstream packages rebuild after upstream). Inputs: `src/**`, `tsconfig.json`, `tsup.config.ts`,
  `package.json`. Outputs: `dist/**`.
- `typecheck`, `lint`, `test` — same shape, narrower input set.
- `dev` — `cache: false`, `persistent: true`.

Run any task with `pnpm <task>`. Pass through to a single package with `pnpm --filter @inflowpayai/x402-seller <task>`.

Cache lives in `.turbo/` and `.gitignore`d.

## Changesets

[Changesets](https://github.com/changesets/changesets) handles version bumps and changelog generation. Configured in `.changeset/config.json`:

- `access: 'public'` — every published package is public.
- `baseBranch: 'main'`.
- `changelog: ['@changesets/changelog-github', { repo: 'inflowpayai/inflow-node' }]`
  — generates changelog entries with PR + commit links.
- `ignore: ['@inflowpayai/example-*']` — examples never publish.

CLI:

- `pnpm changeset` — interactive: pick packages, bump type, write the summary.
- `pnpm changeset status` — show pending changesets.
- `pnpm changeset version` — apply pending changesets to `package.json` + `CHANGELOG.md`. Run by the release workflow, not directly.
- `pnpm release` — runs `pnpm build && changeset publish`. Run by the release workflow.

See [publishing.md](./publishing.md) for the full release flow.

## TypeScript 5.6+

`tsconfig.base.json` at the root defines the shared compiler options. Each package extends it and sets `rootDir: src` + `outDir: dist`.

The base config is strict:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `module: 'NodeNext'`, `target: 'ES2022'`

`composite` is intentionally **disabled** — tsup's DTS generation can't work with composite projects, and turbo's `^build` ordering already
handles dependency order without project references.

Each package ships two tsconfigs:

- `tsconfig.json` — `include: ["src/**/*.ts"]`. The build (`tsup`) and the publishable typecheck use this.
- `tsconfig.test.json` — extends `tsconfig.json`, widens `rootDir` to `.`, sets `noEmit: true`, adds `vitest/globals` to `types`, and
  `include: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]`. Tests typecheck against this.

The package-level `typecheck` script runs `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`, so `pnpm typecheck` covers both src and
tests. Without this split, vitest's esbuild transformer happily ran tests with latent type errors; the split closes that gap.

A third `tsconfig.docs.json` at the repo root scopes typedoc's compilation surface to `packages/*/src` only (no tests, no examples,
no Next route files).

## tsup 8

[tsup](https://tsup.egoist.dev) builds each package. Per-package `tsup.config.ts` enables `dts`, `sourcemap`, dual `esm` + `cjs` output,
`target: 'node22'`, `treeshake: true`.

tsup leaves declared `peerDependencies` (`@x402/core`, etc.) unbundled by default, so the published artifacts never embed a copy of the
peer.

`@inflowpayai/x402` uses a multi-entry build to expose subpath exports (`./security`, `./extensions`, `./extras`).

## Vitest 2

[Vitest](https://vitest.dev) runs unit + property tests with v8 coverage. Per-package `vitest.config.ts`:

- `environment: 'node'`, `include: ['test/**/*.test.ts']`.
- Coverage thresholds: 90/85/90/90 (lines/branches/functions/statements).
- `passWithNoTests: true` on packages that don't yet have tests.

CI's `pnpm test` runs with coverage and fails below the floor.

## MSW 2

[Mock Service Worker](https://mswjs.io) intercepts `fetch` and node `http` for unit tests. Each package's `test/unit/*.test.ts` sets up a
fresh `server = setupServer()` and registers handlers per test via `server.use(...)`.

## ESLint 9 (flat config)

`eslint.config.js` uses the flat config format with `typescript-eslint`'s `recommended` ruleset and `eslint-config-prettier`
to disable Prettier-conflict rules. `pnpm lint` is configured per package as `eslint src test --max-warnings 0` — the
type-aware ESLint rules cover both `packages/**/src/**` and `packages/**/test/**` (the type-aware pass uses
`tsconfig.test.json` as the explicit project so test files resolve under `projectService`-equivalent semantics).

## Prettier 3

`.prettierrc.json` pins the format: single quotes, trailing commas, `printWidth: 120`, semis, 2-space indent.

`prettier-plugin-jsdoc` is enabled, so `pnpm format` also reflows the body of every TSDoc / JSDoc comment to the same `printWidth`. The
plugin runs in `tsdoc: true` mode (TSDoc tag conventions, including `{@link}` and `@internal`) and `jsdocPreferCodeFences: true`
(`@example` blocks keep their triple-backtick fences instead of being indent-converted).

`pnpm format` writes the whole tree; `pnpm format:check` exists as a script but is not currently called from CI.

## fast-check

Used in `packages/x402-seller/test/property/inflow-accepts.test.ts`. Typical invariants: filter idempotence, filter monotonicity, order
stability, and shape invariants on the emitted `PaymentOption[]`.

## Publish-correctness scripts (`scripts/`)

Two Node ESM scripts under `scripts/` guard against publish-time pitfalls. Both run from CI and from the release workflow; neither runs at
commit time (they need a populated `dist/`).

- `scripts/check-exports.mjs` (exposed as `pnpm check-exports`) — walks each publishable package's `exports` map, asserts every referenced
  file resolves on disk after build, and asserts every conditional block lists `types` first per the TypeScript dual-package handbook.
- `scripts/verify-publish.mjs` (exposed as `pnpm verify-publish`) — runs `pnpm pack --dry-run --json` per publishable package and asserts
  the resulting tarball entries include `dist/`, `README.md`, and `LICENSE`; warns on accidental test-file inclusion.

`pnpm check-publish` is the convenience alias that runs `pnpm build && pnpm check-exports && pnpm verify-publish` — use it before tagging
a release. The release script (`pnpm release`) chains the same two checks between `turbo run build` and `changeset publish`, so
they also gate the published artifact automatically.

A third script, `scripts/check-no-build-artifacts.mjs`, is wired into `.husky/pre-commit` instead — it's build-free and runs every commit
to reject staged `.next/`, `.turbo/`, and `*.tsbuildinfo` paths. The two publish-correctness scripts above are deliberately **not** in
husky because they require a fresh build (slow at commit time).

## GitHub Actions

Two workflows:

- `.github/workflows/ci.yml` — runs on every PR and push to `main`. Matrix: Node `[22, 24]` × `x402-foundation: [locked, latest]`. Steps:
  install, lint, typecheck, build, check-exports, verify-publish, test, changeset-check (on PRs), upload coverage artifact. The matrix
  is a superset of `engines.node: >=22.0.0` — 22 is the floor users see, 24 is the active LTS. See "Node version management" in
  [AGENTS.md](../../AGENTS.md) for the three-knob model.
- `.github/workflows/release.yml` — runs on push to `main`. Uses `changesets/action@v1` to open the version PR or publish.

See [publishing.md](./publishing.md) for the release-side detail and [contributing.md](./contributing.md) for the contributor side.

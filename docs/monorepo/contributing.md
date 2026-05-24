# Contributing

How to land changes in this monorepo.

## Prerequisites

- Node 24 (active LTS) for development. The `.nvmrc` pins 24. CI runs on the same. pnpm 11.1.3 (pinned in `packageManager`) imports `node:sqlite` and will not start on Node < 22.13, so older Node is a non-starter regardless. The published packages declare `engines.node: >=22.13.0` and target Node 22 at the tsup build level — that's a consumer claim, separate from this contributor tooling requirement.
- pnpm 11.x. Corepack will install the exact version pinned in the root `package.json#packageManager` field — you don't need to install pnpm globally.

## Setup

```bash
git clone git@github.com:inflowpayai/inflow-node.git
cd inflow-node
corepack enable
pnpm install --frozen-lockfile
```

The first install will take a few minutes. Subsequent commands hit turbo's cache and are usually instant.

## Daily workflow

```bash
pnpm typecheck    # tsc --noEmit against tsconfig.json + tsconfig.test.json per package (turbo'd)
pnpm lint         # eslint src test --max-warnings 0 (turbo'd; covers both src/ and test/)
pnpm build        # tsup, dual ESM + CJS + .d.ts (turbo'd)
pnpm test         # turbo runs each package's vitest run --coverage; thresholds enforced per-package
pnpm format       # prettier write — also reflows TSDoc bodies to printWidth via prettier-plugin-jsdoc (direct — not turbo'd)
pnpm typedoc      # generate API reference into docs/api/ (gitignored)
```

The first four run via Turborepo. Cache hits are reported on the right-hand side of each line; touch a file in one package and only that
package plus its dependents rebuild. `format` runs prettier directly across the whole tree.

Pre-release / publish troubleshooting scripts:

```bash
pnpm check-exports    # validates each package's `exports` map resolves on disk after build
pnpm verify-publish   # `pnpm pack --dry-run` per package; asserts dist/, README.md, LICENSE in each tarball
pnpm check-publish    # builds, then runs the two above — use before tagging a release
```

These run automatically in `.github/workflows/ci.yml` (between Build and Test) and inside `pnpm release`, so the normal flow doesn't need
them. See [publishing.md](./publishing.md) for the full release pipeline.

To run a single package's tests:

```bash
pnpm --filter @inflowpayai/x402-seller test
```

To watch a single package:

```bash
pnpm --filter @inflowpayai/x402-seller test:watch
```

## Branch model

A single long-lived `main` branch. Feature work happens on short-lived branches off `main`:

```bash
git switch -c feat/x402-buyer-better-retry
# … hack …
git push -u origin feat/x402-buyer-better-retry
gh pr create --base main
```

PRs that touch `packages/**` need a Changeset entry. CI fails the PR without one.

```bash
pnpm changeset
# select packages, pick patch/minor/major, write the summary
git add .changeset/*.md && git commit -m "chore: add changeset"
git push
```

See [publishing.md](./publishing.md) for the full release flow.

## Commit convention

Conventional Commits. Pick one of `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`. Scope by package:

```
feat(x402-seller): add inflowAccepts permit2 emission
fix(x402-buyer): poll loop respects retries: 0
docs(monorepo): clarify branch model
refactor(x402-seller): collapse capability table into facilitator client
```

The release-PR generation step uses Conventional Commits to produce the `CHANGELOG.md` entries.

## Code style

- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`, no `!` assertions, no
  `as unknown as` casts except at documented type boundaries (see `packages/x402-buyer/src/inflow-client.ts` for the canonical pattern —
  the foundation `x402Client` doesn't accept InFlow's widened `network: string`).
- Comments describe what the code does or why it exists right now. No references to phases, milestones, server-side internals, or
  "future work."
- Use the typed accessor helpers (`@inflowpayai/x402/extensions`, `@inflowpayai/x402/extras`) rather than direct bracket access on
  open-ended `extra` / `extensions` maps.
- Lint emoji-free unless the request explicitly calls for them.

## Tests

- Vitest. Per-package `vitest.config.ts`. MSW for HTTP mocking (Node mode). `fast-check` for property tests where a unit invariant fits.
- Coverage threshold ≥90% lines / functions / statements, ≥85% branches — enforced. `pnpm test` fails the build below the floor.
- Defensive guards that can't be reached from external inputs should be marked `/* v8 ignore start/stop */` rather than hand-crafted tests
  that exist purely to satisfy coverage.

## Adding a new package

When adding one, follow the same template as the existing three (`x402`, `x402-seller`, `x402-buyer`):

- `packages/<name>/{src,test/unit}`
- `package.json` with `"version": "1.0.0"`, `peerDependencies`, `publishConfig.access: public`, `publishConfig.provenance: true`
- `tsconfig.json` extending `tsconfig.base.json`
- `tsup.config.ts` + `vitest.config.ts`
- `README.md`

Then `pnpm install` to update the lockfile.

## Reporting bugs

Use GitHub Issues. For security-sensitive findings, see [SECURITY.md](../../SECURITY.md).

## See also

- [publishing.md](./publishing.md) — release flow, npm provenance, first publish.
- [tooling.md](./tooling.md) — pnpm, Turborepo, Changesets, Vitest, tsup reference.

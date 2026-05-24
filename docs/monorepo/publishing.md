# Publishing

How releases work in this monorepo: Changesets-driven, npm provenance, single-branch trunk.

## Release model

A single long-lived `main` branch hosts shipped code. Feature work happens on short-lived branches off `main`, merges via PR back to
`main`. Releases are gated by [Changesets](https://github.com/changesets/changesets), not by branch merges.

## When to add a changeset

Add one before merging any PR that touches `packages/**`. From the repo root:

```bash
pnpm changeset
```

Pick the affected packages, pick the bump type (`patch` / `minor` / `major`), and write a short user-facing summary. The CLI writes a `*.md`
file under `.changeset/`; commit it alongside your code change. CI fails the PR if `packages/**` changed without a `.changeset/*.md` companion.

Examples don't need changesets — `@inflowpayai/example-*` is in the `ignore` list in `.changeset/config.json`.

## Release flow on merge to `main`

The `release` workflow runs on every push to `main`. It uses the official `changesets/action@v1`:

1. **No pending changesets**: workflow is a no-op.
2. **Pending changesets exist**: the Changesets bot opens (or updates) a "chore(release): version packages" PR. The diff shows the version
   bumps and `CHANGELOG.md` entries each changeset would produce. The maintainer reviews and merges.
3. **Version Packages PR merges**: workflow runs again, detects the applied versions, and calls `pnpm release` which runs
   `changeset publish`. Each bumped package is published to npm with provenance attestations (OIDC-backed).

The workflow's final step iterates `steps.changesets.outputs.publishedPackages` and queries `npm view <name>@<version> --json` for each just-published version, asserting `.dist.attestations` is non-null. Any package landing without a provenance attestation fails the run. (We do not use `npm audit signatures` for this — that command audits dependencies installed in `node_modules`, not the tarballs we just published, and it can't see this repo's workspaces because they're declared in `pnpm-workspace.yaml` rather than `package.json#workspaces`.)

## Publish-correctness gates

Two scripts under `scripts/` validate every publishable package against publish-time pitfalls and run automatically:

- **`scripts/check-exports.mjs`** — walks each package's `exports` map and confirms every referenced path resolves on disk after build, and that every conditional block lists `types` first per the TypeScript dual-package handbook. Surfaced as `pnpm check-exports`.
- **`scripts/verify-publish.mjs`** — runs `pnpm pack --dry-run` per publishable package and asserts each tarball contains `dist/`, `README.md`, and `LICENSE`; warns on accidental test-file inclusion. Surfaced as `pnpm verify-publish`.

Both run automatically in:

1. **CI on every PR and push** (`.github/workflows/ci.yml`) — between the `Build` and `Test` steps. A broken `exports` map or a missing `LICENSE` fails CI before the PR can merge.
2. **The release pipeline** — `pnpm release` (invoked by `changesets/action@v1` when publishing) chains `turbo run build && pnpm check-exports && pnpm verify-publish && changeset publish`, so a malformed tarball never reaches npm.

Run both locally before tagging a release or whenever publish-time troubleshooting is needed:

```bash
pnpm check-publish    # builds, then runs check-exports + verify-publish
```

The combined `check-publish` script depends on a fresh `pnpm build`; the individual `check-exports` / `verify-publish` scripts assume `dist/` is already populated.

## npm setup (one-time)

1. **Create the `@inflowpayai` scope on npmjs.com.** Use a team-owned account, not an individual.
2. **Bootstrap each package's npm record, then register Trusted Publishing.** Trusted Publishing is configured per package on the package's npmjs.com settings page, which only exists after the package has been published at least once — see "First publish bootstrap" below for the procedure. Once each record points at this repo's `release.yml`, the release workflow publishes via OIDC (`permissions.id-token: write`) with the `npm publish --provenance` defaults from npm 11+, and no `NPM_TOKEN` secret lives in repo settings.
3. **Verify provenance after a CI publish:**
   ```bash
   pnpm view @inflowpayai/x402 --json | jq '.dist.attestations'
   ```

## First publish bootstrap

Trusted Publishing has a chicken-and-egg: a package's Trusted Publisher record can only be created after the package exists on npm. The first publish therefore runs from a developer machine with a short-lived granular token; every publish after that runs from CI under OIDC.

Source versions in `packages/*/package.json` are at `0.5.0`. The bootstrap publishes those source versions directly with no version bump — there are no pending changesets to apply.

1. **Gate the release workflow** so it cannot race the local publish and fail with `E403`. In `.github/workflows/release.yml`, flip the trigger from `on: push: branches: [main]` to `on: workflow_dispatch:`. Commit and push.
2. **Dry-run locally:**
   ```bash
   pnpm install --frozen-lockfile
   pnpm check-publish    # builds, then check-exports + verify-publish
   ```
   Every publishable package should report a non-empty tarball with `dist/`, `README.md`, and `LICENSE`.
3. **Confirm clean changeset state:**
   ```bash
   pnpm changeset status --since=origin/main
   ```
4. **Mint a single-use granular access token** on npmjs.com scoped to `@inflowpayai` (read/write, 1-day expiry). Authenticate the local npm CLI and publish. Every package has `publishConfig.provenance: true`, which fails without an OIDC context, so the bootstrap run overrides it:
   ```bash
   echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" >> ~/.npmrc
   NPM_CONFIG_PROVENANCE=false pnpm release
   ```
   `pnpm release` is `turbo run build && pnpm check-exports && pnpm verify-publish && changeset publish`. With no pending changesets, `changeset publish` finds each package's `0.5.0` source version newer than npm and publishes `@inflowpayai/x402`, `@inflowpayai/x402-buyer`, and `@inflowpayai/x402-seller` without provenance attestations.
5. **Register a Trusted Publisher on each package.** For each of `@inflowpayai/x402`, `@inflowpayai/x402-buyer`, `@inflowpayai/x402-seller`: open `https://www.npmjs.com/package/<package>`, go to the Settings tab → Trusted Publishers → Add. Publisher `GitHub Actions`, organization `inflowpayai`, repository `inflow-node`, workflow filename `release.yml`, environment blank.
6. **Restore the release trigger:** revert `release.yml` to `on: push: branches: [main]`, commit, and push. The release workflow re-runs with no pending changesets and source versions matching npm, so `changeset publish` is a no-op and the run goes green. The path is live for the next change.
7. **Revoke the granular token** on npm and strip the `_authToken=` line from `~/.npmrc`. Confirm `Settings → Secrets and variables → Actions` on GitHub has no `NPM_TOKEN` — Trusted Publishing makes one structurally unnecessary.

The first CI-driven publish with provenance happens on the next change. To prove the OIDC path end-to-end before relying on it, add a no-op patch changeset for all three packages, merge it, then merge the resulting Version Packages PR — the `release` workflow runs `changeset publish` under OIDC and each package page should show the **Provenance: Signed and verified** badge. The workflow's final verify step (registry query of `.dist.attestations` per published version) fails the run if any package lands without attestations.

From `0.5.1` onward, every change flows through the normal Changesets flow.

## Linking related bumps

Today the three packages version independently. When an x402 protocol-level change requires synchronous bumps across the whole tree
(e.g. a `PaymentRequirements` shape change), use a `linked` group in `.changeset/config.json`:

```jsonc
"linked": [
  ["@inflowpayai/x402", "@inflowpayai/x402-seller", "@inflowpayai/x402-buyer"]
]
```

Changesets will then bump every package in the group together. The current pre-1.x state intentionally leaves `linked` empty — packages
should be able to ship independent fixes.

## Pre-release tags (alpha / beta / rc)

For pre-release flows:

```bash
pnpm changeset pre enter alpha
# edit changesets as usual
git push
# … release workflow publishes @inflowpayai/x402@1.1.0-alpha.0, etc.
pnpm changeset pre exit
```

`alpha` / `beta` / `rc` are conventions; any tag works.

## Yanking a release

Don't. Instead, publish a `patch` that supersedes the broken release. `npm deprecate` the broken version after the patch is live so consumers
see a warning on install:

```bash
pnpm exec npm deprecate @inflowpayai/x402-seller@1.2.3 \
  "Broken release; use 1.2.4 or later (#issue-number)"
```

## See also

- [contributing.md](./contributing.md) — branch model, PR template, local test workflow.
- [tooling.md](./tooling.md) — pnpm, Turborepo, Changesets reference.

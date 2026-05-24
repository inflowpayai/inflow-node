#!/usr/bin/env bash
# Local pre-push gate. Runs the same checks `.github/workflows/ci.yml` runs on
# every PR and every push to `main`. Run this before `git push` to catch
# failures locally instead of on GitHub Actions.
#
# Usage:
#   scripts/ci-local.sh           # default `locked` matrix leg
#   scripts/ci-local.sh locked    # @x402/* pinned to lockfile (default)
#   scripts/ci-local.sh latest    # @x402/* overridden to latest 2.x
#   scripts/ci-local.sh both      # run `locked` then `latest`
#
# Requires Node >= 24 to match what CI runs (the active LTS). pnpm@11.1.3
# itself needs Node >= 22.13 for `node:sqlite`, but we pin the dev floor to
# 24 so local runs exercise the same runtime as CI. Published packages still
# allow Node 22.13+ at consumer install time via `engines.node`.

set -euo pipefail

mode="${1:-locked}"
case "$mode" in
  locked|latest|both) ;;
  *)
    echo "error: unknown mode '$mode'" >&2
    echo "usage: $0 [locked|latest|both]" >&2
    exit 2
    ;;
esac

# Restore any working-tree pollution from the `latest` leg's `pnpm -r update`,
# which rewrites package.json specifiers and pnpm-lock.yaml. Without this, an
# accidental `git add -A` after running the script can sweep those bumps into
# an unrelated commit.
cleanup() {
  if [[ "$mode" == "latest" || "$mode" == "both" ]]; then
    echo ""
    echo ">>> Restoring working tree (packages/, examples/, pnpm-lock.yaml, package.json)"
    git restore packages/ examples/ pnpm-lock.yaml package.json 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Node version guard -----------------------------------------------------
node_version=$(node --version | sed 's/^v//')
node_major=${node_version%%.*}
if [[ "$node_major" -lt 24 ]]; then
  echo "error: Node >= 24 required to match the CI matrix. Found v${node_version}." >&2
  echo "  nvm:  nvm install 24 && nvm use 24" >&2
  echo "  fnm:  fnm install 24 && fnm use 24" >&2
  exit 1
fi

# --- Steps mirrored from .github/workflows/ci.yml ---------------------------
run_leg() {
  local leg="$1"

  echo ""
  echo "==> Leg: ${leg}"

  echo ">>> Install (frozen lockfile)"
  pnpm install --frozen-lockfile

  if [[ "$leg" == "latest" ]]; then
    echo ">>> Override @x402/* foundation packages to latest 2.x"
    # Mirrors the matrix override step. Bumps every @x402/* package the
    # workspace declares — not just @x402/core — because each foundation
    # package carries its own peer-resolved @x402/core and leaving them at
    # their 2.12.x line creates duplicate-resolution typecheck failures.
    pnpm -r update \
      '@x402/core@latest' \
      '@x402/evm@latest' \
      '@x402/express@latest' \
      '@x402/extensions@latest' \
      '@x402/fastify@latest' \
      '@x402/hono@latest' \
      '@x402/next@latest' \
      '@x402/paywall@latest' \
      '@x402/svm@latest'
  fi

  echo ">>> Lint"
  pnpm lint

  echo ">>> Typecheck"
  pnpm typecheck

  echo ">>> Build"
  pnpm build

  echo ">>> Check exports map"
  pnpm check-exports

  echo ">>> Verify publish tarballs"
  pnpm verify-publish

  echo ">>> Test"
  pnpm test

  echo ">>> Changeset status (treats unreleased PRs as informational)"
  # CI runs this only on `pull_request`; locally it surfaces pending changesets
  # without failing so you can see the state before committing.
  pnpm changeset status --since=origin/main || true

  echo ""
  echo "Leg '${leg}' passed."
}

if [[ "$mode" == "both" ]]; then
  run_leg locked
  # Reset @x402/* to the lockfile before the `latest` leg so it doesn't pick
  # up the previous leg's leftovers and skip the bump.
  pnpm install --frozen-lockfile
  run_leg latest
else
  run_leg "$mode"
fi

echo ""
echo "All local CI gates passed."

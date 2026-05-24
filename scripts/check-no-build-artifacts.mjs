#!/usr/bin/env node
/**
 * Pre-commit guard: fail if a `.next/` (or any of a small set of generated
 * build artifact paths) shows up in the staged changeset.
 *
 * Wired through `.husky/pre-commit`. Catches the common foot-gun of running
 * `git add -A` after a Next.js example dev server has produced a `.next/`
 * dir under `examples/x402-seller-next/`. Those paths are gitignored in
 * theory but the staging-area-then-amend pattern can still pull them in.
 *
 * Exits 0 with nothing to do, 1 with a diagnostic, or skips silently if
 * the script is invoked outside a git checkout (e.g. via `npm pack`).
 */
import { execFileSync } from 'node:child_process';

/** Path globs (as RegExps anchored to the start of a path) that we refuse to commit. */
const REJECT_PATTERNS = [
  // Next.js build output
  /(^|\/)\.next\//u,
  // Turbo cache
  /(^|\/)\.turbo\//u,
  // tsbuildinfo files (incremental compile state)
  /(^|\/)[^/]+\.tsbuildinfo$/u,
];

function getStagedPaths() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
    });
    return out.split('\n').filter((line) => line.length > 0);
  } catch {
    // Outside a git checkout, or git isn't available. Nothing to do.
    return [];
  }
}

const staged = getStagedPaths();
const offenders = staged.filter((p) => REJECT_PATTERNS.some((re) => re.test(p)));

if (offenders.length > 0) {
  process.stderr.write(
    'pre-commit: refusing to commit generated build artifacts.\n' +
      'These paths matched a forbidden pattern (.next/, .turbo/, *.tsbuildinfo):\n' +
      offenders.map((p) => `  ${p}\n`).join('') +
      '\nRun `git restore --staged <path>` (or `git reset HEAD <path>`), confirm the\n' +
      'underlying files are gitignored, and re-commit.\n',
  );
  process.exit(1);
}

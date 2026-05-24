#!/usr/bin/env node
/**
 * Delete vitest config bundling artifacts left behind by vite-node's `bundle-require` between test runs.
 *
 * Each `vitest run` invocation writes `<package>/vitest.config.ts.timestamp-<digits>-<hex>.mjs` next to the config and
 * does not unlink it on clean exit (verified empirically). Without cleanup these accumulate.
 *
 * Wired three ways:
 *   - `posttest` in the root `package.json` (the common dev case).
 *   - `.husky/pre-commit` (catches leftovers from watch sessions).
 *   - `.gitignore` covers the pattern as a safety net.
 *
 * Exits 0 on success; never blocks the parent command.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const PATTERN = /^vitest\.config\.[^.]+\.timestamp-\d+-[a-f0-9]+\.mjs$/u;

async function listSubdirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function unlinkMatching(dir) {
  let count = 0;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!PATTERN.test(name)) continue;
    try {
      await fs.unlink(path.join(dir, name));
      count += 1;
    } catch {
      // Best-effort; never block the caller.
    }
  }
  return count;
}

const packageDirs = await listSubdirs(PACKAGES_DIR);
let total = 0;
for (const dir of packageDirs) {
  total += await unlinkMatching(dir);
}
if (total > 0) {
  process.stdout.write(`clean-vitest-artifacts: deleted ${total.toString()} file(s)\n`);
}

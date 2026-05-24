#!/usr/bin/env node
// Iterate every publishable package and run `pnpm pack --dry-run`.
// Asserts each tarball contains dist/, README.md, LICENSE; warns on
// accidental test-file inclusion. Exits non-zero on the first failure.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

const REQUIRED_TARBALL_ENTRIES = ['dist/', 'README.md', 'LICENSE'];
const FORBIDDEN_PATTERNS = [/^test\//u, /\.test\.[mc]?[jt]s$/u, /\.spec\.[mc]?[jt]s$/u];

/**
 * Discover every publishable package under packages/.
 *
 * @returns {Promise<Array<{ name: string; dir: string; pkg: any }>>}
 */
async function discoverPackages() {
  const entries = await fs.readdir(PACKAGES_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const packages = [];
  for (const d of dirs) {
    const dir = path.join(PACKAGES_DIR, d.name);
    const pkgPath = path.join(dir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.private === true) continue;
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@inflowpayai/')) continue;
    packages.push({ name: pkg.name, dir, pkg });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run `pnpm pack --dry-run --json` and parse the file list.
 *
 * @param {string} dir - Package directory.
 * @returns {Promise<{ entries: string[]; size: number }>}
 */
async function dryRunPack(dir) {
  const { stdout } = await execFileP('pnpm', ['pack', '--dry-run', '--json'], { cwd: dir });
  // pnpm pack --json emits the npm-pack JSON shape (array with one entry).
  const parsed = JSON.parse(stdout);
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = Array.isArray(record?.files) ? record.files : [];
  const entries = files.map((f) => f.path);
  const size = typeof record?.size === 'number' ? record.size : 0;
  return { entries, size };
}

function checkTarball(entries) {
  const missing = REQUIRED_TARBALL_ENTRIES.filter(
    (req) => !entries.some((e) => (req.endsWith('/') ? e.startsWith(req) : e === req)),
  );
  const forbidden = entries.filter((e) => FORBIDDEN_PATTERNS.some((p) => p.test(e)));
  return { missing, forbidden };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const packages = await discoverPackages();
  if (packages.length === 0) {
    console.error('verify-publish: no publishable packages found under packages/');
    process.exit(1);
  }

  let failed = 0;
  console.log(`verify-publish: ${packages.length.toString()} publishable packages\n`);

  for (const { name, dir } of packages) {
    process.stdout.write(`  ${name} ... `);
    let result;
    try {
      result = await dryRunPack(dir);
    } catch (err) {
      console.log('FAIL');
      console.error(`    pnpm pack failed: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
      continue;
    }
    const { missing, forbidden } = checkTarball(result.entries);
    if (missing.length > 0) {
      console.log('FAIL');
      console.error(`    missing required entries: ${missing.join(', ')}`);
      failed += 1;
      continue;
    }
    if (forbidden.length > 0) {
      console.log('WARN');
      console.warn(`    test-like entries found in tarball: ${forbidden.join(', ')}`);
    } else {
      console.log(`OK  (${result.entries.length} files, ${fmtBytes(result.size)})`);
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`verify-publish: ${failed.toString()} package(s) failed`);
    process.exit(1);
  }
  console.log('verify-publish: all packages OK');
}

main().catch((err) => {
  console.error('verify-publish: unexpected error');
  console.error(err);
  process.exit(1);
});

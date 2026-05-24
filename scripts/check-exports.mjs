#!/usr/bin/env node
// Validate each publishable package's `exports` field:
//   - every referenced file path exists on disk after `pnpm build`;
//   - every conditional block has `types` first (per the TypeScript
//     handbook's dual-package guidance);
//   - `main`, `module`, `types` (top-level) all resolve.
// Exits non-zero on the first violation.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');

/**
 * Discover every publishable package under packages/.
 *
 * @returns {Promise<Array<{ name: string; dir: string; pkg: any }>>}
 */
async function discoverPackages() {
  const entries = await fs.readdir(PACKAGES_DIR, { withFileTypes: true });
  const packages = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
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

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively walk an `exports` subtree, collecting `{ subpath, condition,
 * file }` triples and flagging any block where a `types` condition exists
 * but doesn't appear first.
 */
function* walkExports(node, subpath, conditionChain) {
  if (typeof node === 'string') {
    yield { subpath, condition: conditionChain.join(' > ') || 'default', file: node };
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const keys = Object.keys(node);
  // The TS handbook says `types` must come first in any conditional
  // block. Check that here for nested-condition objects (the top-level
  // subpath map doesn't have this constraint).
  if (conditionChain.length > 0 && keys.includes('types') && keys[0] !== 'types') {
    yield {
      subpath,
      condition: conditionChain.join(' > '),
      file: null,
      error: `'types' is not the first conditional key (found order: ${keys.join(', ')})`,
    };
  }
  for (const key of keys) {
    if (key === 'package.json' || key === 'default') {
      // Recurse with the key appended.
      yield* walkExports(node[key], subpath, [...conditionChain, key]);
    } else {
      yield* walkExports(node[key], subpath, [...conditionChain, key]);
    }
  }
}

async function checkPackage({ name, dir, pkg }) {
  const errors = [];
  const seen = new Set();

  // Top-level fields.
  for (const field of ['main', 'module', 'types']) {
    const value = pkg[field];
    if (typeof value !== 'string') continue;
    const full = path.join(dir, value);
    seen.add(full);
    if (!(await fileExists(full))) {
      errors.push(`${field}: "${value}" does not exist`);
    }
  }

  // `exports` map.
  const exportsField = pkg.exports;
  if (exportsField !== undefined && exportsField !== null) {
    if (typeof exportsField === 'string') {
      const full = path.join(dir, exportsField);
      seen.add(full);
      if (!(await fileExists(full))) errors.push(`exports: "${exportsField}" does not exist`);
    } else if (typeof exportsField === 'object') {
      for (const [subpath, sub] of Object.entries(exportsField)) {
        for (const entry of walkExports(sub, subpath, [])) {
          if (entry.error !== undefined) {
            errors.push(`exports["${entry.subpath}"]: ${entry.error}`);
            continue;
          }
          if (typeof entry.file !== 'string') continue;
          if (entry.file === './package.json' || subpath === './package.json') {
            const full = path.join(dir, entry.file);
            if (!(await fileExists(full))) {
              errors.push(`exports["${entry.subpath}"]: "${entry.file}" does not exist`);
            }
            continue;
          }
          const full = path.join(dir, entry.file);
          seen.add(full);
          if (!(await fileExists(full))) {
            errors.push(
              `exports["${entry.subpath}"] (${entry.condition}): "${entry.file}" does not exist`,
            );
          }
        }
      }
    }
  }

  return errors;
}

async function main() {
  const packages = await discoverPackages();
  if (packages.length === 0) {
    console.error('check-exports: no publishable packages found under packages/');
    process.exit(1);
  }

  let failed = 0;
  console.log(`check-exports: ${packages.length.toString()} publishable packages\n`);

  for (const entry of packages) {
    process.stdout.write(`  ${entry.name} ... `);
    const errors = await checkPackage(entry);
    if (errors.length === 0) {
      console.log('OK');
    } else {
      console.log('FAIL');
      for (const e of errors) console.error(`    ${e}`);
      failed += 1;
    }
  }

  console.log('');
  if (failed > 0) {
    console.error(`check-exports: ${failed.toString()} package(s) failed`);
    process.exit(1);
  }
  console.log('check-exports: all packages OK');
}

main().catch((err) => {
  console.error('check-exports: unexpected error');
  console.error(err);
  process.exit(1);
});

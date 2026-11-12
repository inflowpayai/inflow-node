import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function isDevelopmentDependencyUpdate(baseRef, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const base = git('merge-base', baseRef, 'HEAD').trim();
  const files = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD').split('\0').filter(Boolean);
  if (files.length === 0) return false;

  return files.every((file) => {
    if (file === 'pnpm-lock.yaml' || file.startsWith('examples/')) return true;
    if (file !== 'package.json' && !/^packages\/[^/]+\/package\.json$/.test(file)) return false;

    const readManifest = (ref) => {
      try {
        return JSON.parse(git('show', `${ref}:${file}`));
      } catch {
        return null;
      }
    };
    const before = readManifest(base);
    const after = readManifest('HEAD');
    if (!before || !after) return false;

    const { devDependencies: beforeDev, ...beforePublished } = before;
    const { devDependencies: afterDev, ...afterPublished } = after;
    return isDeepStrictEqual(beforePublished, afterPublished) && !isDeepStrictEqual(beforeDev, afterDev);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseRef = process.argv[2] ?? 'origin/main';
  if (isDevelopmentDependencyUpdate(baseRef)) {
    console.log('Changeset not required: only development dependencies, examples, or the lockfile changed.');
  } else {
    const result = spawnSync('pnpm', ['changeset', 'status', `--since=${baseRef}`], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}

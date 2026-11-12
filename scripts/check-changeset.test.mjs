import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDevelopmentDependencyUpdate } from './check-changeset.mjs';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'inflow-changeset-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const write = (file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test',
    );
  };
  const manifest = {
    name: '@inflowpayai/example-sdk',
    version: '1.0.0',
    dependencies: { runtime: '^1.0.0' },
    peerDependencies: { peer: '^1.0.0' },
    devDependencies: { tooling: '^1.0.0' },
  };
  git('init', '-q', '--initial-branch=main');
  write('package.json', { name: 'test-workspace', private: true, devDependencies: { tooling: '^1.0.0' } });
  write('packages/sdk/package.json', manifest);
  write('packages/sdk/src/index.ts', 'export const value = 1;');
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0');
  commit();
  git('branch', 'base');
  return { cwd, git, write, commit, manifest };
}

test('exempts package development dependency updates with example and lockfile changes', (t) => {
  const repo = repository(t);
  repo.write('packages/sdk/package.json', { ...repo.manifest, devDependencies: { tooling: '^2.0.0' } });
  repo.write('examples/server/package.json', { private: true, dependencies: { tooling: '^2.0.0' } });
  repo.write('pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: {}');
  repo.commit();
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), true);
});

test('exempts root development dependencies and example-only or lockfile-only updates', (t) => {
  const repo = repository(t);
  for (const [file, content] of [
    ['package.json', { name: 'test-workspace', private: true, devDependencies: { tooling: '^2.0.0' } }],
    ['examples/server/index.ts', 'export const example = true;'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0\nimporters: {}'],
  ]) {
    repo.write(file, content);
    repo.commit();
    assert.equal(isDevelopmentDependencyUpdate('HEAD~1', repo.cwd), true, file);
  }
});

for (const [field, value] of [
  ['dependencies', { runtime: '^2.0.0' }],
  ['optionalDependencies', { runtime: '^1.0.0' }],
  ['peerDependencies', { peer: '^2.0.0' }],
  ['peerDependenciesMeta', { peer: { optional: true } }],
  ['scripts', { build: 'custom-build' }],
  ['engines', { node: '>=24' }],
  ['version', '2.0.0'],
  ['exports', './different.js'],
]) {
  test(`retains the Changeset check for ${field}, even alongside development dependency updates`, (t) => {
    const repo = repository(t);
    repo.write('packages/sdk/package.json', {
      ...repo.manifest,
      devDependencies: { tooling: '^2.0.0' },
      [field]: value,
    });
    repo.commit();
    assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), false);
  });
}

test('retains the check for source, package additions, deletions, and malformed manifests', (t) => {
  const repo = repository(t);
  for (const [file, content] of [
    ['packages/sdk/src/index.ts', 'export const value = 2;'],
    ['packages/new/package.json', { name: 'new', version: '1.0.0', devDependencies: {} }],
    ['packages/sdk/package.json', '{invalid'],
  ]) {
    repo.write(file, content);
    repo.commit();
    assert.equal(isDevelopmentDependencyUpdate('HEAD~1', repo.cwd), false, file);
  }
  repo.git('rm', 'packages/sdk/package.json');
  repo.commit();
  assert.equal(isDevelopmentDependencyUpdate('HEAD~1', repo.cwd), false);
});

test('a mixed source and development dependency change is not exempt', (t) => {
  const repo = repository(t);
  repo.write('packages/sdk/package.json', { ...repo.manifest, devDependencies: { tooling: '^2.0.0' } });
  repo.write('packages/sdk/src/index.ts', 'export const value = 2;');
  repo.commit();
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), false);
});

test('compares against the merge base rather than unrelated new base-branch changes', (t) => {
  const repo = repository(t);
  repo.write('packages/sdk/package.json', { ...repo.manifest, devDependencies: { tooling: '^2.0.0' } });
  repo.commit();
  repo.git('checkout', '-q', 'base');
  repo.write('packages/sdk/src/index.ts', 'export const value = 2;');
  repo.commit();
  repo.git('checkout', '-q', 'main');
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), true);
});

test('does not exempt an empty diff or hide an invalid base reference', (t) => {
  const repo = repository(t);
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), false);
  assert.throws(() => isDevelopmentDependencyUpdate('missing-ref', repo.cwd));
});

test('the real Changesets CLI still requires a Changeset for runtime updates', (t) => {
  const repo = repository(t);
  repo.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  repo.write('.changeset/config.json', { baseBranch: 'base', changelog: false });
  repo.commit();
  repo.git('branch', '-f', 'base', 'HEAD');
  const cli = fileURLToPath(new URL('../node_modules/@changesets/cli/bin.js', import.meta.url));
  const status = () =>
    spawnSync(process.execPath, [cli, 'status', '--since=base'], { cwd: repo.cwd, encoding: 'utf8' });

  repo.write('packages/sdk/package.json', { ...repo.manifest, devDependencies: { tooling: '^2.0.0' } });
  repo.commit();
  const development = status();
  assert.equal(development.status, 1);
  assert.match(development.stderr, /no changesets were found/);
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), true);
  const script = fileURLToPath(new URL('./check-changeset.mjs', import.meta.url));
  const exemption = spawnSync(process.execPath, [script, 'base'], { cwd: repo.cwd, encoding: 'utf8' });
  assert.equal(exemption.status, 0, exemption.stderr);
  assert.match(exemption.stdout, /Changeset not required/);

  repo.write('packages/sdk/package.json', { ...repo.manifest, dependencies: { runtime: '^2.0.0' } });
  repo.commit();
  assert.equal(isDevelopmentDependencyUpdate('base', repo.cwd), false);
  const runtime = status();
  assert.equal(runtime.status, 1);
  assert.match(runtime.stderr, /no changesets were found/);

  repo.write(
    '.changeset/runtime-update.md',
    '---\n"@inflowpayai/example-sdk": patch\n---\nUpdate runtime dependency.\n',
  );
  repo.commit();
  const released = status();
  assert.equal(released.status, 0, released.stderr);
});

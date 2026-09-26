import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { implementation, verifyContract } from './conformance.mjs';

test('contract selection requires an exact commit and a clean checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inflow-contract-test-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const revision = git('rev-parse', 'HEAD');
    assert.doesNotThrow(() => verifyContract(root, revision));
    for (const invalid of ['main', revision.slice(0, 7), 'a'.repeat(39), 'g'.repeat(40), `${revision}\n`])
      assert.throws(() => verifyContract(root, invalid), /full commit SHA/);
    assert.throws(() => verifyContract(root, '0'.repeat(40)), /clean contract checkout/);
    await writeFile(join(root, 'fixture.txt'), 'local change');
    assert.throws(() => verifyContract(root, revision), /clean contract checkout/);
    git('add', 'fixture.txt');
    assert.throws(() => verifyContract(root, revision), /clean contract checkout/);
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'second fixture');
    const current = git('rev-parse', 'HEAD');
    assert.throws(() => verifyContract(root, revision), /clean contract checkout/);
    assert.doesNotThrow(() => verifyContract(root, current));
    await writeFile(join(root, 'fixture.txt'), 'modified tracked file');
    assert.throws(() => verifyContract(root, current), /clean contract checkout/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('report runtime comes from the selected adapter executable', async () => {
  assert.equal((await implementation('runtime', process.execPath)).runtime, process.version);
  await assert.rejects(() => implementation('runtime', '/nonexistent/inflow-test-node'), /ENOENT/);
});

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { PaymentReplayProduct, PaymentReplayResponse } from '@inflowpayai/x402-seller/express';

import { SqliteReplayStore } from './replay-store.js';

const product: PaymentReplayProduct = {
  status: 201,
  headers: { 'content-type': 'application/octet-stream' },
  body: Uint8Array.from([0, 255, 17]),
  paymentPayload: {
    x402Version: 2,
    payload: { signature: '0xtest' },
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10',
      asset: '0xasset',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    },
  },
  paymentRequirements: {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10',
    asset: '0xasset',
    payTo: '0xseller',
    maxTimeoutSeconds: 300,
    extra: {},
  },
  declaredExtensions: {},
};

void test('SQLite claims, staged recovery, fencing and binary completion survive separate connections and reopen', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'inflow-replay-store-'));
  context.after(() => {
    rmSync(directory, { recursive: true });
  });
  const file = join(directory, 'replay.sqlite');
  const first = new SqliteReplayStore(file);
  const files = [file, `${file}-wal`, `${file}-shm`];
  for (const path of files) chmodSync(path, 0o644);
  const second = new SqliteReplayStore(file);
  for (const path of files) assert.equal(statSync(path).mode & 0o777, 0o600);
  context.mock.timers.enable({ apis: ['Date'], now: 1000 });
  try {
    const claim = await first.claim('key', 'fingerprint', { isValid: true });
    assert.equal(claim.type, 'owned');
    if (claim.type !== 'owned') throw new Error('expected ownership');
    assert.equal((await second.claim('key', 'fingerprint', { isValid: true })).type, 'pending');
    assert.equal((await second.claim('key', 'changed', { isValid: true })).type, 'conflict');
    assert.equal(await second.lookup('key', 'changed'), 'conflict');
    assert.equal(await first.complete('key', claim.token, product), false);
    context.mock.timers.tick(120001);
    // Expiry cannot reclaim an operation whose application handler may have run but has not staged a product.
    assert.equal((await second.claim('key', 'fingerprint', { isValid: true })).type, 'pending');
    assert.equal(await first.stage('key', claim.token, product), true);
    // Staging after a long-running handler starts a fresh recovery lease, rather than exposing an expired claim.
    assert.equal((await second.claim('key', 'fingerprint', { isValid: true })).type, 'pending');
    context.mock.timers.tick(120001);
    const recovered = await second.claim('key', 'fingerprint', { isValid: true });
    assert.equal(recovered.type, 'owned');
    if (recovered.type !== 'owned') throw new Error('expected recovered ownership');
    assert.notEqual(recovered.token, claim.token);
    assert.deepEqual(recovered.product, product);
    assert.equal(await first.stage('key', claim.token, product), false);
    const response: PaymentReplayResponse = {
      status: product.status,
      headers: { ...product.headers, 'payment-response': 'original-receipt' },
      body: product.body,
    };
    assert.equal(await first.complete('key', claim.token, response), false);
    assert.equal(await second.stage('key', recovered.token, product), true);
    assert.equal(await second.complete('key', recovered.token, response), true);
    const completed = await first.claim('key', 'fingerprint', { isValid: true });
    assert.equal(completed.type, 'completed');
    if (completed.type !== 'completed') throw new Error('expected completed response');
    assert.deepEqual(completed.response, response);
  } finally {
    context.mock.timers.reset();
    first.close();
    second.close();
  }
  const reopened = new SqliteReplayStore(file);
  try {
    const record = await reopened.lookup('key', 'fingerprint');
    assert.notEqual(record, undefined);
    if (record === undefined || record === 'conflict' || record.state !== 'completed')
      throw new Error('expected durable completion');
    assert.deepEqual(record.response.body, product.body);
    assert.equal(record.response.headers['payment-response'], 'original-receipt');
  } finally {
    reopened.close();
  }
});

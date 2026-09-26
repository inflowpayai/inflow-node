import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as buyer from '../packages/mpp-buyer/dist/index.js';
import { MppCodecError } from '../packages/mpp/dist/index.js';
import { classify, respond } from '../conformance/mpp-shared-adapter.mjs';
import { implementation } from './conformance.mjs';

const request = (operation, input) => ({ adapter_version: '1', sequence: 1, case_id: 'test.case', operation, input });

test('MPP adapter handles JSON lines and preserves null codec input', () => {
  const inputs = [request('mpp.core.encode', { value: null }), request('mpp.core.decode', { value: 'bnVsbA' })];
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../conformance/mpp-shared-adapter.mjs', import.meta.url))],
    {
      input: inputs.map((item) => JSON.stringify(item)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.map((item) => item.result),
    ['bnVsbA', null],
  );
  for (const response of responses) {
    assert.equal(response.sequence, 1);
    assert.equal(response.case_id, 'test.case');
  }
});

test('failure classification uses SDK error types, preserving problems and identifiers', () => {
  const problem = { type: 'test:failure', title: 'Rejected', extensions: { reference: 'test-only' } };
  for (const [error, expected] of [
    [
      new buyer.MppPaymentExpiredError('tx'),
      { code: 'payment-expired', message: 'Payment expired.', details: { transaction_id: 'tx' } },
    ],
    [
      new buyer.MppPaymentTimeoutError(1000, 'tx'),
      { code: 'payment-timeout', message: 'Payment timed out.', details: { transaction_id: 'tx' } },
    ],
    [new buyer.MppPaymentCancelledError('approval'), { code: 'payment-cancelled', message: 'Payment cancelled.' }],
    [new buyer.MppMalformedCredentialError('missing'), { code: 'invalid-credential', message: 'Invalid credential.' }],
    [
      new buyer.MppPaymentFailedError(problem),
      { code: 'payment-failed', message: 'Payment failed.', details: { problem } },
    ],
    [new buyer.MppPaymentFailedError(), { code: 'payment-failed', message: 'Payment failed.' }],
    [new MppCodecError('input', 'invalid'), { code: 'invalid-input', message: 'Invalid input.' }],
  ])
    assert.deepEqual(classify(error, 'mpp.buyer.fulfil'), expected);
  assert.equal(
    classify(new MppCodecError('credential', 'invalid'), 'mpp.core.decode-credential').code,
    'invalid-credential',
  );
  const unknown = new Error('MPP payment cancelled by caller');
  assert.throws(
    () => classify(unknown, 'mpp.buyer.cancel'),
    (error) => error === unknown,
  );
});

test('adapter rejects external destinations and unsupported operations rather than simulating success', async () => {
  for (const input of [
    request('mpp.seller.verify', {}),
    request('mpp.buyer.fulfil', { base_url: 'https://example.com' }),
    request('mpp.buyer.fulfil', { base_url: 'http://user@127.0.0.1:1' }),
    request('mpp.buyer.fulfil', {
      base_url: 'http://127.0.0.1:1',
      challenge: { method: 'tempo', intent: 'subscription' },
    }),
    { ...request('mpp.core.encode', { value: null }), adapter_version: '2' },
  ])
    assert.equal((await respond(input)).error.code, 'ADAPTER_ERROR');
});

test('public Buyer method performs pending-to-failed polling and cleanup over real HTTP', async () => {
  const seen = [];
  let cancelled;
  const cancellation = new Promise((resolve) => {
    cancelled = resolve;
  });
  const problem = { type: 'test:rejected', title: 'Rejected', extensions: { reason: 'test-only' } };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      key: req.headers['x-api-key'],
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/transactions/mpp')
      res.end(JSON.stringify({ state: 'pending', transactionId: 'test-tx', approvalId: 'test-approval' }));
    else if (req.url === '/v1/transactions/test-tx/mpp') res.end(JSON.stringify({ state: 'failed', problem }));
    else {
      res.end('{}');
      cancelled();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let timer;
  try {
    const input = {
      base_url: `http://127.0.0.1:${server.address().port}`,
      api_key: 'test-only-key',
      challenge: { id: 'test-id', realm: 'example.com', method: 'inflow', intent: 'charge', request: 'e30' },
      context: {},
    };
    const before = structuredClone(input);
    const result = await respond(request('mpp.buyer.fulfil', input));
    assert.deepEqual(result.error, { code: 'payment-failed', message: 'Payment failed.', details: { problem } });
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Missing approval cancellation')), 5000);
      }),
    ]);
    assert.deepEqual(
      seen.map(({ method, url }) => ({ method, url })),
      [
        { method: 'POST', url: '/v1/transactions/mpp' },
        { method: 'GET', url: '/v1/transactions/test-tx/mpp' },
        { method: 'POST', url: '/v1/approvals/test-approval/cancel' },
      ],
    );
    assert.deepEqual(JSON.parse(seen[0].body), { challenge: input.challenge, options: {} });
    assert.ok(seen.every(({ key }) => key === input.api_key));
    assert.deepEqual(input, before);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('MPP report includes both SDK packages and their installed foundation version', async () => {
  const result = await implementation('mpp');
  assert.deepEqual(Object.keys(result.packages).sort(), ['@inflowpayai/mpp', '@inflowpayai/mpp-buyer']);
  for (const product of ['mpp', 'mpp-buyer']) {
    const manifest = JSON.parse(
      await readFile(new URL(`../packages/${product}/package.json`, import.meta.url), 'utf8'),
    );
    const installed = JSON.parse(
      await readFile(new URL(`../packages/${product}/node_modules/mppx/package.json`, import.meta.url), 'utf8'),
    );
    assert.equal(result.packages[manifest.name], manifest.version);
    assert.deepEqual(result.dependencies, { mppx: installed.version });
  }
});

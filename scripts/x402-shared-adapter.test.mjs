import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { InflowApiError } from '../packages/x402/dist/index.js';
import * as buyer from '../packages/x402-buyer/dist/index.js';
import * as seller from '../packages/x402-seller/dist/index.js';
import { classify, respond } from '../conformance/x402-shared-adapter.mjs';
import { implementation } from './conformance.mjs';

const request = (operation, input) => ({ adapter_version: '1', sequence: 7, case_id: 'test.case', operation, input });

test('x402 adapter handles multiple JSON lines without treating null as an absent input', () => {
  const inputs = [null, 'a'.repeat(16)].map((value) => request('x402.core.identifier-valid', { value }));
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../conformance/x402-shared-adapter.mjs', import.meta.url))],
    { input: inputs.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 5000 },
  );
  const responses = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    responses.map((value) => value.result),
    [false, true],
  );
  for (const response of responses) {
    assert.equal(response.sequence, 7);
    assert.equal(response.case_id, 'test.case');
    assert.equal(response.adapter_version, '1');
  }
});

test('x402 classification requires SDK error types and preserves status and complete API bodies', () => {
  const body = { code: 'TEMPORARY_ERROR', details: { retry: 'later' } };
  for (const [error, expected] of [
    [
      new InflowApiError('failure', { code: 'TEMPORARY_ERROR', httpStatus: 503, endpoint: '/test', body }),
      { code: 'api-error', message: 'InFlow API request failed.', http_status: 503, details: { body } },
    ],
    [
      new buyer.X402ApprovalFailedError('approval', 'DECLINED'),
      { code: 'payment-failed', message: 'Payment failed.', details: { status: 'DECLINED' } },
    ],
    [new buyer.X402ApprovalTimeoutError('approval', 1000), { code: 'payment-timeout', message: 'Payment timed out.' }],
    [new buyer.X402ApprovalCancelledError('approval'), { code: 'payment-cancelled', message: 'Payment cancelled.' }],
    [new buyer.X402PaymentIdFormatError('short'), { code: 'invalid-input', message: 'Invalid input.' }],
    [new seller.X402PriceParseError('-1 USDC'), { code: 'invalid-input', message: 'Invalid input.' }],
    [
      new buyer.X402AdapterRoutingError('exact', 'unknown'),
      { code: 'unsupported-capability', message: 'Unsupported payment capability.' },
    ],
  ])
    assert.deepEqual(classify(error), expected);
  const unknown = new Error('Payment failed.');
  assert.throws(
    () => classify(unknown),
    (error) => error === unknown,
  );
});

test('adapter rejects unknown operations, versions and non-loopback destinations', async () => {
  for (const input of [
    request('x402.unknown', {}),
    request('x402.seller.verify', {}),
    request('x402.seller.verify', { base_url: 'https://example.com' }),
    request('x402.buyer.sign', { base_url: 'https://example.com' }),
    request('x402.buyer.sign', { base_url: 'http://user@127.0.0.1:1' }),
    { ...request('x402.core.identifier-valid', { value: 'a'.repeat(16) }), adapter_version: '2' },
  ])
    assert.equal((await respond(input)).error.code, 'ADAPTER_ERROR');
});

test('identifier entries preserve declarations and do not manufacture an invalid identifier', async () => {
  const declaration = (await respond(request('x402.core.identifier-declaration', {}))).result;
  declaration.info.merchant = 'test-shop';
  for (const id of ['a'.repeat(16), 'short']) {
    const input = { declaration, payment_id: id };
    const before = structuredClone(input);
    const response = await respond(request('x402.core.identifier-entry', input));
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, id === 'short' ? null : { ...declaration, info: { ...declaration.info, id } });
    assert.deepEqual(input, before);
  }
});

for (const scenario of ['concurrent', 'failed', 'cancel', 'cancel-failed', 'create-failed']) {
  test(`public Buyer lifecycle over HTTP: ${scenario}`, async () => {
    const seen = [];
    const payload = { marker: 'actual-response-not-derived-by-adapter' };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({
        path: req.url,
        method: req.method,
        key: req.headers['x-api-key'],
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/transactions/x402-supported')
        res.end(JSON.stringify({ kinds: [{ scheme: 'balance', network: 'inflow:1', x402Version: 2 }] }));
      else if (req.url === '/v1/transactions/x402') {
        res.statusCode = scenario === 'create-failed' ? 503 : 200;
        res.end(
          JSON.stringify(
            scenario === 'create-failed'
              ? { code: 'TEMPORARY_ERROR' }
              : {
                  transactionId: 'test-tx',
                  approvalId: 'test-approval',
                  approvalStatus: 'PENDING',
                },
          ),
        );
      } else if (req.url === '/v1/transactions/test-tx/x402')
        res.end(
          JSON.stringify(
            scenario === 'failed'
              ? { status: 'DECLINED' }
              : {
                  status: 'PENDING',
                  encodedPayload: 'actual-wire-value',
                  paymentPayload: payload,
                },
          ),
        );
      else {
        res.statusCode = scenario === 'cancel-failed' ? 503 : 204;
        res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const input = {
        base_url: `http://127.0.0.1:${server.address().port}`,
        api_key: 'test-only-key',
        payment_id: 'a'.repeat(16),
        requirement: {
          scheme: 'balance',
          network: 'inflow:1',
          asset: 'USDC',
          amount: '1',
          payTo: 'seller',
          maxTimeoutSeconds: 300,
        },
        context: { resource: { url: 'https://seller.example/test' }, x402Version: 2 },
      };
      const before = structuredClone(input);
      const operation =
        scenario === 'concurrent' ? 'concurrent-await' : scenario.startsWith('cancel') ? 'cancel' : 'sign';
      const response = await respond(request(`x402.buyer.${operation}`, input));
      if (scenario === 'concurrent')
        assert.deepEqual(response.result, {
          encodedPayload: 'actual-wire-value',
          paymentPayload: payload,
          transactionId: 'test-tx',
        });
      else
        assert.equal(
          response.error.code,
          scenario.startsWith('cancel') ? 'payment-cancelled' : scenario === 'failed' ? 'payment-failed' : 'api-error',
        );
      assert.deepEqual(
        seen.map(({ path, method }) => ({ path, method })),
        [
          { path: '/v1/transactions/x402-supported', method: 'GET' },
          { path: '/v1/transactions/x402', method: 'POST' },
          ...(scenario === 'create-failed'
            ? []
            : [
                {
                  path: scenario.startsWith('cancel')
                    ? '/v1/approvals/test-approval/cancel'
                    : '/v1/transactions/test-tx/x402',
                  method: scenario.startsWith('cancel') ? 'POST' : 'GET',
                },
              ]),
        ],
      );
      assert.deepEqual(JSON.parse(seen[1].body), {
        accept: { ...input.requirement, extra: {} },
        resource: input.context.resource,
        x402Version: 2,
        remotePaymentId: input.payment_id,
      });
      assert.ok(seen.every(({ key }) => key === input.api_key));
      assert.deepEqual(input, before);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

test('x402 report records all three packages and their installed foundation versions', async () => {
  const result = await implementation('x402');
  assert.deepEqual(Object.keys(result.packages).sort(), [
    '@inflowpayai/x402',
    '@inflowpayai/x402-buyer',
    '@inflowpayai/x402-seller',
  ]);
  for (const product of ['x402', 'x402-buyer', 'x402-seller']) {
    const manifest = JSON.parse(
      await readFile(new URL(`../packages/${product}/package.json`, import.meta.url), 'utf8'),
    );
    const installed = JSON.parse(
      await readFile(new URL(`../packages/${product}/node_modules/@x402/core/package.json`, import.meta.url), 'utf8'),
    );
    assert.equal(result.packages[manifest.name], manifest.version);
    assert.equal(result.dependencies['@x402/core'], installed.version);
  }
  const extensions = JSON.parse(
    await readFile(
      new URL('../packages/x402-seller/node_modules/@x402/extensions/package.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(Object.keys(result.dependencies).sort(), ['@x402/core', '@x402/extensions']);
  assert.equal(result.dependencies['@x402/extensions'], extensions.version);
});

for (const scenario of [
  'accepted',
  'rejected',
  'pending',
  'unrelated-conflict',
  'anonymous',
  'allowance',
  'unrelated-412',
]) {
  test(`public Seller facilitator over HTTP: ${scenario}`, async () => {
    const seen = [];
    let settlements = 0;
    const verification =
      scenario === 'rejected'
        ? { isValid: false, invalidReason: 'invalid_payload' }
        : scenario === 'allowance'
          ? { isValid: false, invalidReason: 'permit2_allowance_required' }
          : { isValid: true, payer: 'test-payer' };
    const settlement = { success: true, transaction: 'test-tx', network: 'inflow:1' };
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({
        path: req.url,
        method: req.method,
        key: req.headers['x-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/x402/verify') {
        res.statusCode = ['allowance', 'unrelated-412'].includes(scenario) ? 412 : 200;
        res.end(JSON.stringify(scenario === 'unrelated-412' ? { code: 'PRECONDITION_FAILED' } : verification));
      } else if (req.url === '/v1/x402/settle') {
        settlements += 1;
        const pending = scenario === 'pending' && settlements === 1;
        res.statusCode = pending || scenario === 'unrelated-conflict' ? 409 : 200;
        res.setHeader('retry-after', '0');
        res.end(
          JSON.stringify(
            pending
              ? { success: false, errorReason: 'idempotency_pending' }
              : scenario === 'unrelated-conflict'
                ? { code: 'CONFLICT' }
                : settlement,
          ),
        );
      } else {
        res.statusCode = 500;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const requirement = {
        scheme: 'balance',
        network: 'inflow:1',
        asset: 'USDC',
        amount: '1',
        payTo: 'seller',
        maxTimeoutSeconds: 300,
      };
      const input = {
        base_url: `http://127.0.0.1:${server.address().port}`,
        ...(scenario === 'anonymous' ? {} : { api_key: 'test-only-key' }),
        payment_requirements: requirement,
        payment_payload: {
          x402Version: 2,
          accepted: requirement,
          resource: { url: 'https://seller.example/test' },
          payload: { transactionId: 'test-tx' },
          extensions: { custom: { info: { value: 'preserve' } } },
        },
      };
      const before = structuredClone(input);
      const verifyOnly = ['anonymous', 'allowance', 'unrelated-412'].includes(scenario);
      const result = await respond(request(verifyOnly ? 'x402.seller.verify' : 'x402.seller.verify-settle', input));
      if (scenario === 'unrelated-412' || scenario === 'unrelated-conflict')
        assert.deepEqual(result.error, {
          code: 'api-error',
          message: 'InFlow API request failed.',
          http_status: scenario === 'unrelated-412' ? 412 : 409,
          details: { body: { code: scenario === 'unrelated-412' ? 'PRECONDITION_FAILED' : 'CONFLICT' } },
        });
      else
        assert.deepEqual(
          result.result,
          verifyOnly
            ? verification
            : {
                verification,
                ...(scenario === 'rejected' ? {} : { settlement }),
              },
        );
      assert.deepEqual(
        seen.map(({ path }) => path),
        [
          '/v1/x402/verify',
          ...(verifyOnly || scenario === 'rejected'
            ? []
            : Array(scenario === 'pending' ? 2 : 1).fill('/v1/x402/settle')),
        ],
      );
      assert.ok(seen.every(({ key, method }) => key === input.api_key && method === 'POST'));
      const identifier = seen[0].body.paymentPayload.extensions['payment-identifier'];
      assert.match(identifier.info.id, /^pay_[a-f0-9]{32}$/);
      for (const call of seen) {
        assert.deepEqual(call.body, seen[0].body);
        assert.deepEqual(call.body.paymentRequirements, requirement);
        assert.deepEqual(call.body.paymentPayload.extensions.custom, input.payment_payload.extensions.custom);
      }
      assert.deepEqual(input, before);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

test('Seller offer conversion preserves exact amounts and caller-owned configuration', async () => {
  const input = {
    config: {
      assets: [],
      wallets: [],
      supported: [],
      paymentMethods: [{ scheme: 'balance', network: 'inflow:1', payTo: 'seller', decimals: 8 }],
    },
    options: { price: '9007199254740993 USDC' },
  };
  const before = structuredClone(input);
  const response = await respond(request('x402.seller.offers', input));
  assert.equal(response.error, undefined);
  assert.equal(response.result[0].price.amount, '900719925474099300000000');
  assert.deepEqual(input, before);
  const invalid = { ...input, options: { price: '-1 USDC' } };
  assert.deepEqual((await respond(request('x402.seller.offers', invalid))).error, {
    code: 'invalid-input',
    message: 'Invalid input.',
  });
});

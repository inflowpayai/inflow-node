import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { respond } from '../conformance/runtime-adapter.mjs';
import { runtimeCases } from '../conformance/runtime-cases.mjs';
import { implementation } from './runtime-conformance.mjs';

test('report records installed upstream versions rather than dependency ranges', async () => {
  const result = await implementation();
  assert.equal(result.runtime, process.version);
  for (const [product, dependency] of [
    ['mpp', 'mppx'],
    ['x402', '@x402/core'],
  ]) {
    const manifest = JSON.parse(
      await readFile(new URL(`../packages/${product}/package.json`, import.meta.url), 'utf8'),
    );
    const installed = JSON.parse(
      await readFile(
        new URL(`../packages/${product}/node_modules/${dependency}/package.json`, import.meta.url),
        'utf8',
      ),
    );
    assert.equal(result.packages[manifest.name], manifest.version);
    assert.equal(result.dependencies[dependency], installed.version);
    assert.notEqual(result.dependencies[dependency], manifest.peerDependencies[dependency]);
  }
  assert.deepEqual(Object.keys(result.dependencies).sort(), ['@x402/core', 'mppx']);
});

const request = (input, operation = 'runtime.requests') => ({
  adapter_version: '1',
  sequence: 1,
  case_id: 'test.case',
  operation,
  input,
});

test('adapter serves multiple JSON-lines requests with matching envelope identifiers', () => {
  const first = request({ product: 'mpp', options: {} }, 'runtime.environment');
  const second = { ...first, sequence: 2, case_id: 'second.case', input: { product: 'x402', options: {} } };
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../conformance/runtime-adapter.mjs', import.meta.url))],
    {
      input: `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  const responses = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  for (const [index, input] of [first, second].entries()) {
    assert.deepEqual(responses[index], {
      adapter_version: '1',
      sequence: input.sequence,
      case_id: input.case_id,
      result: { resolved: 'https://api.inflowpay.ai', client: 'https://api.inflowpay.ai' },
    });
  }
});

for (const product of ['mpp', 'x402']) {
  test(`${product}: adapter observes the real transport and preserves caller input`, async () => {
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], bearer: req.headers.authorization });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'SELLER_ACCOUNT_REQUIRED', message: 'Seller required.' }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const input = {
        product,
        base_url: `http://127.0.0.1:${server.address().port}`,
        api_key: 'test-only-key',
        calls: [{ method: 'GET', path: '/v1/mpp/config', options: { retries: 0 } }],
      };
      const snapshot = structuredClone(input);
      const response = await respond(request(input));
      assert.deepEqual(response.result, {
        token_calls: 0,
        outcomes: [
          {
            code: 'SELLER_ACCOUNT_REQUIRED',
            http_status: 403,
            message: 'Seller required.',
            endpoint: '/v1/mpp/config',
            request_id: null,
            sensitive_headers: [],
          },
        ],
      });
      assert.deepEqual(seen, [{ method: 'GET', url: '/v1/mpp/config', key: 'test-only-key', bearer: undefined }]);
      assert.deepEqual(input, snapshot);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  test(`${product}: environment inspection makes no request`, async () => {
    const response = await respond(request({ product, options: { environment: 'sandbox' } }, 'runtime.environment'));
    assert.deepEqual(response.result, {
      resolved: 'https://sandbox.inflowpay.ai',
      client: 'https://sandbox.inflowpay.ai',
    });
  });
}

test('adapter rejects unsupported operations, versions, methods and external destinations', async () => {
  for (const item of [
    request({ product: 'other' }),
    request({ product: 'mpp' }, 'unknown'),
    { ...request({ product: 'mpp' }), adapter_version: '2' },
    request({ product: 'mpp', base_url: 'https://example.com', calls: [] }),
    request({ product: 'mpp', base_url: 'http://127.0.0.1:1', calls: [{ method: 'DELETE', path: '/test' }] }),
    request({ product: 'mpp', base_url: 'http://127.0.0.1:1', calls: [{ method: 'GET', path: '//example.com' }] }),
  ]) {
    const response = await respond(item);
    assert.equal(response.error.code, 'ADAPTER_ERROR');
    assert.equal(response.sequence, item.sequence);
    assert.equal(response.case_id, item.case_id);
    assert.equal(Object.hasOwn(response, 'result'), false);
  }
});

test('case builder preserves fixtures and executes each scenario through both products', () => {
  const scenarios = {
    sample: {
      exchanges: [
        { request: { method: 'GET', path: '/test', headers: {} }, response: { status: 200, json: { hello: 'world' } } },
      ],
    },
  };
  const before = structuredClone(scenarios);
  const { cases } = runtimeCases(scenarios);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const product of ['mpp', 'x402']) {
    assert.equal(cases.filter((item) => item.id === `${product}.sample`).length, 1);
  }
  assert.deepEqual(scenarios, before);
});

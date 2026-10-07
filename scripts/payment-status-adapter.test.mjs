import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { respond as mpp } from '../conformance/mpp-shared-adapter.mjs';
import { respond as x402 } from '../conformance/x402-shared-adapter.mjs';

for (const [protocol, respond] of [
  ['mpp', mpp],
  ['x402', x402],
]) {
  for (const failure of [false, true]) {
    test(`${protocol} status adapter preserves recovery fields and failures without payment mutations: ${failure}`, async () => {
      const seen = [];
      const action = { type: 'authenticate_card', url: 'https://dashboard.example/verify/' };
      const body = { errors: [{ code: 'UNAVAILABLE', message: 'Synthetic failure' }] };
      const server = createServer((req, res) => {
        seen.push({
          method: req.method,
          path: req.url,
          auth: req.headers.authorization,
          key: req.headers['x-api-key'],
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/transactions/x402-supported') return res.end(JSON.stringify({ kinds: [] }));
        res.statusCode = failure ? 503 : 200;
        res.end(
          JSON.stringify(failure ? body : { transactionId: 'tx', status: 'PENDING', nextAction: action, amount: '1' }),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const input = {
          base_url: `http://127.0.0.1:${server.address().port}`,
          access_token: 'test-only-token',
          transaction_id: 'tx',
          reads: 2,
        };
        const before = structuredClone(input);
        const result = await respond({
          adapter_version: '1',
          sequence: 1,
          case_id: 'status',
          operation: `${protocol}.buyer.payment-status`,
          input,
        });
        if (failure)
          assert.deepEqual(result.error, {
            code: 'api-error',
            message: 'InFlow API request failed.',
            http_status: 503,
            details: { body },
          });
        else
          assert.deepEqual(
            result.result,
            Array.from({ length: 2 }, () => ({ transactionId: 'tx', status: 'PENDING', nextAction: action })),
          );
        assert.equal(seen.length, (failure ? 1 : 2) + (protocol === 'x402' ? 1 : 0));
        assert.ok(
          seen.every(
            (entry) => entry.method === 'GET' && entry.auth === 'Bearer test-only-token' && entry.key === undefined,
          ),
        );
        assert.deepEqual(input, before);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
}

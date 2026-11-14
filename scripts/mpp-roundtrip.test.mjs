import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { decode, encodeCredential } from '../packages/mpp/dist/index.js';
import * as buyer from '../packages/mpp-buyer/dist/index.js';
import * as seller from '../packages/mpp-seller/dist/index.js';

async function listen(t, handler) {
  const server = createServer(handler);
  t.after(async () => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

for (const scenario of ['success', 'validation-rejected', 'pending', 'handler-failed']) {
  test(`MPP buyer and seller round trip: ${scenario}`, { timeout: 5000 }, async (t) => {
    const events = [];
    const failures = [];
    let issued;
    let receipt;
    // Only the remote payment service is simulated. Both SDKs and mppx run normally.
    const baseUrl = await listen(t, (request, response) => {
      void (async () => {
        assert.equal(request.headers['x-api-key'], 'synthetic-key');
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/mpp/config') {
          response.end(
            JSON.stringify({
              sellerId: '22222222-2222-4222-8222-222222222222',
              featureFlags: { idempotencyKeyEnabled: true },
              replayPolicy: { managedBy: 'psp' },
              supportedMethods: [
                {
                  id: 'inflow',
                  label: 'InFlow',
                  supportedCurrencies: ['USDC'],
                  supportedIntents: ['charge'],
                  methodDetails: { intentCurrencyRails: { charge: { USDC: [{ rail: 'balance' }] } } },
                },
              ],
            }),
          );
          return;
        }
        assert.equal(request.method, 'POST');
        const body = JSON.parse(await text(request));
        if (request.url === '/v1/transactions/mpp') {
          events.push('create');
          issued = {
            challenge: body.challenge,
            payload: { transactionId: '11111111-1111-4111-8111-111111111111' },
            source: 'did:inflow:buyer',
          };
          response.end(JSON.stringify({ state: 'ready', credential: encodeCredential(issued) }));
          return;
        }
        assert.deepEqual(body.credential, issued);
        const problem = {
          type: 'verification-failed',
          title: 'Payment unavailable',
          status: scenario === 'pending' ? 503 : 402,
          detail: 'Synthetic payment failure',
        };
        if (request.url === '/v1/mpp/validate') {
          events.push('validate');
          response.end(
            JSON.stringify(
              scenario === 'validation-rejected'
                ? { success: false, problem }
                : {
                    success: true,
                    credential: issued,
                    challenge: issued.challenge,
                    method: 'inflow',
                    intent: 'charge',
                    request: decode(issued.challenge.request),
                    source: issued.source,
                    details: {},
                  },
            ),
          );
          return;
        }
        assert.equal(request.url, '/v1/mpp/broadcast');
        events.push('broadcast');
        receipt = {
          challengeId: issued.challenge.id,
          method: 'inflow',
          reference: 'synthetic-settlement',
          status: 'success',
          timestamp: '2026-01-01T00:00:00Z',
        };
        response.end(JSON.stringify(scenario === 'pending' ? { problem } : { receipt }));
      })().catch((error) => {
        failures.push(error);
        response.writeHead(500).end();
      });
    });
    const options = { baseUrl, apiKey: 'synthetic-key', timeoutMs: 2000 };
    const listener = seller.inflowChargesNodeListener(
      seller.Mppx.create({
        methods: [seller.inflow(options)],
        realm: 'seller.test',
        secretKey: 'synthetic-secret-at-least-32-characters',
      }),
      [{ amount: '1', currency: 'USDC' }],
    );
    let requests = 0;
    const resourceUrl = await listen(t, (request, response) => {
      requests += 1;
      assert.equal(request.headers['x-api-key'], undefined);
      void listener(request, response)
        .then((result) => {
          if (result.status !== 200) return;
          events.push('handler');
          response.setHeader('x-application', 'retained');
          response.writeHead(scenario === 'handler-failed' ? 500 : 200).end('application body');
        })
        .catch((error) => {
          failures.push(error);
          response.writeHead(500).end();
        });
    });
    const method = buyer.inflow(options);
    t.after(() => method.cleanup());
    const client = buyer.Mppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 1 });
    const response = await client.fetch(`${resourceUrl}/paid`);
    const body = await response.text();
    assert.deepEqual(failures, []);
    assert.equal(requests, 2);
    assert.deepEqual(events, [
      'create',
      'validate',
      ...(scenario === 'validation-rejected' ? [] : ['broadcast', ...(scenario === 'pending' ? [] : ['handler'])]),
    ]);
    assert.equal(
      response.status,
      { success: 200, 'validation-rejected': 402, pending: 503, 'handler-failed': 500 }[scenario],
    );
    if (scenario === 'success' || scenario === 'handler-failed') {
      assert.equal(body, 'application body');
      assert.equal(response.headers.get('x-application'), 'retained');
      assert.deepEqual(decode(response.headers.get('payment-receipt')), receipt);
    } else {
      assert.equal(response.headers.has('payment-receipt'), false);
    }
  });
}

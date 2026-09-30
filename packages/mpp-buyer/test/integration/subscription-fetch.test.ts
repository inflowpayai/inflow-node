import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { decodeCredential, encode, encodeCredential, renderChallengeHeader } from '@inflowpayai/mpp';
import { expect, it } from 'vitest';

import { inflow, Mppx, MppPaymentFailedError } from '../../src/index.js';

const subscriptionId = '00000000-0000-4000-8000-000000000001';
const challenge = {
  id: 'subscription-fetch',
  realm: 'seller.test',
  method: 'inflow',
  intent: 'subscription',
  request: encode({
    amount: '9.99',
    currency: 'USDC',
    recipient: '00000000-0000-4000-8000-000000000002',
    methodDetails: { rail: 'balance' },
    periodUnit: 'month',
    periodCount: 1,
    subscriptionExpires: '2099-01-01T00:00:00Z',
  }),
};
const credential = {
  challenge,
  source: 'did:inflow:test-buyer',
  payload: { type: 'balance', transactionId: 'test-transaction' },
};

it.each(['omitted', 'empty', 'existing', 'invalid', 'purchase-rejected', 'authorization-rejected'] as const)(
  'uses the real MPP fetch transport for subscription context: %s',
  async (scenario) => {
    const requests: string[] = [];
    const failures: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const path = request.url ?? '';
        requests.push(path);
        response.setHeader('Content-Type', 'application/json');
        if (path === '/paid') {
          expect(request.headers['x-api-key']).toBeUndefined();
          if (request.headers.authorization === undefined) {
            response.writeHead(402, { 'WWW-Authenticate': renderChallengeHeader(challenge) });
            response.end('{}');
          } else {
            expect(decodeCredential(request.headers.authorization.slice('Payment '.length))).toEqual(credential);
            response.end('{"paid":true}');
          }
          return;
        }
        expect(request.method).toBe('POST');
        expect(request.headers['x-api-key']).toBe('synthetic-key');
        const body: unknown = JSON.parse(await text(request));
        const existing = scenario === 'existing' || scenario === 'authorization-rejected';
        expect(path).toBe(existing ? `/v1/subscriptions/${subscriptionId}/authorize` : '/v1/transactions/mpp');
        expect(body).toEqual(existing ? { challenge } : { challenge, options: {} });
        if (scenario.endsWith('rejected')) {
          response.end(
            JSON.stringify({
              state: 'failed',
              problem: { type: 'subscription-inactive', title: 'Rejected', status: 403 },
            }),
          );
        } else {
          response.end(JSON.stringify({ state: 'ready', credential: encodeCredential(credential) }));
        }
      })().catch((error: unknown) => {
        failures.push(error);
        response.writeHead(500).end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const method = inflow.subscription({ apiKey: 'synthetic-key', baseUrl, timeoutMs: 2000 });
    const client = Mppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 1 });
    try {
      const context =
        scenario === 'invalid'
          ? { subscriptionId: 'not-a-uuid' }
          : scenario === 'existing' || scenario === 'authorization-rejected'
            ? { subscriptionId }
            : {};
      const payment = client.fetch(`${baseUrl}/paid`, {
        signal: AbortSignal.timeout(3000),
        ...(scenario === 'omitted' || scenario === 'purchase-rejected' ? {} : { context }),
      });
      if (scenario === 'invalid') {
        await expect(payment).rejects.toThrow();
        expect(requests).toEqual(['/paid']);
      } else if (scenario.endsWith('rejected')) {
        await expect(payment).rejects.toBeInstanceOf(MppPaymentFailedError);
        expect(requests).toEqual([
          '/paid',
          scenario === 'authorization-rejected'
            ? `/v1/subscriptions/${subscriptionId}/authorize`
            : '/v1/transactions/mpp',
        ]);
      } else {
        const response = await payment;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ paid: true });
        expect(requests).toEqual([
          '/paid',
          scenario === 'existing' ? `/v1/subscriptions/${subscriptionId}/authorize` : '/v1/transactions/mpp',
          '/paid',
        ]);
      }
      expect(failures).toEqual([]);
    } finally {
      method.cleanup();
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  },
);

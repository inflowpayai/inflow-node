import { once } from 'node:events';
import { createServer } from 'node:http';
import { Challenge, Credential, Receipt } from 'mppx';
import { decode } from '@inflowpayai/mpp';
import type { MppCredential } from '@inflowpayai/mpp';
import { expect, it } from 'vitest';

import { inflow, inflowChargesNodeListener, inflowSubscriptionsNodeListener, Mppx } from '../../src/index.js';

it.each(['charge', 'subscription'] as const)(
  'recovers config and completes %s through the Node listener',
  async (intent) => {
    const sellerId = '22222222-2222-2222-2222-222222222222';
    let configHits = 0;
    const lifecycle: string[] = [];
    const platform = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/mpp/config') {
        configHits += 1;
        if (configHits === 1) {
          response.writeHead(500).end('{}');
          return;
        }
        response.end(
          JSON.stringify({
            sellerId,
            featureFlags: { idempotencyKeyEnabled: true },
            replayPolicy: { managedBy: 'psp' },
            supportedMethods: [
              {
                id: 'inflow',
                label: 'InFlow',
                supportedCurrencies: ['USDC'],
                supportedIntents: [intent],
                methodDetails: { intentCurrencyRails: { [intent]: { USDC: [{ rail: 'balance' }] } } },
              },
            ],
          }),
        );
        return;
      }
      lifecycle.push(request.url ?? '');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        // This local platform fixture receives only the SDK's serialized credential requests.
        const { credential } = JSON.parse(body) as { credential: MppCredential };
        if (request.url === '/v1/mpp/validate') {
          response.end(
            JSON.stringify({
              success: true,
              challenge: credential.challenge,
              credential,
              details: {},
              intent,
              method: 'inflow',
              request: decode(credential.challenge.request),
              source: credential.source,
            }),
          );
        } else if (request.url === '/v1/mpp/broadcast') {
          response.end(
            JSON.stringify({
              receipt: {
                challengeId: credential.challenge.id,
                method: 'inflow',
                reference: 'receipt-1',
                status: 'success',
                timestamp: new Date().toISOString(),
              },
            }),
          );
        } else response.writeHead(404).end('{}');
      });
    });
    platform.listen(0, '127.0.0.1');
    await once(platform, 'listening');
    const address = platform.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    let gateCalls = 0;
    const options = {
      apiKey: 'synthetic-key',
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      canOffer: ({ input }: { input: Request }) => {
        gateCalls += 1;
        return input.headers.get('x-allow-offer') === 'yes';
      },
    };
    const price = { amount: '1', currency: 'USDC' };
    const framework = { secretKey: 'seller-binding-secret-at-least-32-bytes', realm: 'seller.test' };
    const listener =
      intent === 'charge'
        ? inflowChargesNodeListener(Mppx.create({ ...framework, methods: [inflow(options)] }), [price])
        : inflowSubscriptionsNodeListener(Mppx.create({ ...framework, methods: [inflow.subscription(options)] }), [
            {
              ...price,
              periodUnit: 'month',
              periodCount: 1,
              subscriptionExpires: '2099-01-01T00:00:00Z',
            },
          ]);
    const resource = createServer((request, response) => {
      void listener(request, response)
        .then((result) => {
          if (result.status === 200) response.end('paid content');
        })
        .catch(() => {
          response.writeHead(503).end('Unavailable');
        });
    });
    resource.listen(0, '127.0.0.1');
    await once(resource, 'listening');
    const resourceAddress = resource.address();
    if (resourceAddress === null || typeof resourceAddress === 'string') throw new Error('Expected TCP listener');
    const url = `http://127.0.0.1:${String(resourceAddress.port)}/paid`;
    try {
      const denied = await fetch(url);
      expect(denied.status).toBe(503);
      expect(denied.headers.has('WWW-Authenticate')).toBe(false);
      await denied.text();
      const offered = await fetch(url, { headers: { 'x-allow-offer': 'yes' } });
      expect(offered.status).toBe(402);
      const challenge = Challenge.fromResponse(offered);
      await offered.text();
      expect(configHits).toBe(2);
      expect(lifecycle).toEqual([]);
      const gated = await fetch(url);
      expect(gated.status).toBe(503);
      expect(gated.headers.has('WWW-Authenticate')).toBe(false);
      await gated.text();
      const gatesBeforePayment = gateCalls;
      const paid = await fetch(url, {
        headers: {
          Authorization: Credential.serialize({
            challenge,
            source: 'did:inflow:buyer',
            payload: { transactionId: 'synthetic-transaction' },
          }),
        },
      });
      expect(paid.status).toBe(200);
      expect(await paid.text()).toBe('paid content');
      expect(Receipt.fromResponse(paid).reference).toBe('receipt-1');
      expect(lifecycle).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast']);
      expect(gateCalls).toBe(gatesBeforePayment);
      expect(configHits).toBe(2);
    } finally {
      const closed = [once(resource, 'close'), once(platform, 'close')];
      resource.close();
      resource.closeAllConnections();
      platform.close();
      platform.closeAllConnections();
      await Promise.all(closed);
    }
  },
);

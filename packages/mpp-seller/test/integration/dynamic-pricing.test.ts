import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { Challenge, Credential } from 'mppx';
import { decode } from '@inflowpayai/mpp';
import type { MppCredential } from '@inflowpayai/mpp';
import { expect, it } from 'vitest';

import { inflow, inflowCharges, inflowChargesNodeListener, Mppx, paymentHttpTransport } from '../../src/index.js';

it.each([
  ['fetch', 'GET', 'unread'],
  ['fetch', 'POST', 'unread'],
  ['fetch', 'POST', 'consumed'],
  ['fetch', 'POST', 'locked'],
  ['node', 'GET', 'unread'],
] as const)(
  'prices per request through the %s helper for %s with a %s body through real mppx composition',
  async (adapter, method, bodyState) => {
    let configHits = 0;
    const events: string[] = [];
    const platform = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/mpp/config') {
        configHits += 1;
        response.end(
          JSON.stringify({
            sellerId: '22222222-2222-2222-2222-222222222222',
            featureFlags: { idempotencyKeyEnabled: true },
            replayPolicy: { managedBy: 'psp' },
            supportedMethods: [
              {
                id: 'inflow',
                supportedIntents: ['charge'],
                supportedCurrencies: ['USDC', 'USDT', 'USD'],
                methodDetails: {
                  intentCurrencyRails: {
                    charge: { USDC: [{ rail: 'balance' }], USDT: [{ rail: 'balance' }], USD: [{ rail: 'instrument' }] },
                  },
                },
              },
            ],
          }),
        );
        return;
      }
      events.push(request.url ?? '');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        // The local platform receives the SDK's serialized credential, not a fabricated mppx response.
        const { credential } = JSON.parse(body) as { credential: MppCredential };
        if (request.url === '/v1/mpp/validate') {
          response.end(
            JSON.stringify({
              success: true,
              credential,
              challenge: credential.challenge,
              details: {},
              intent: 'charge',
              method: 'inflow',
              source: credential.source,
              request: decode(credential.challenge.request),
            }),
          );
        } else if (request.url === '/v1/mpp/broadcast') {
          response.end(
            JSON.stringify({
              receipt: {
                challengeId: credential.challenge.id,
                method: 'inflow',
                reference: 'payment-1',
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
    const mppx = Mppx.create({
      methods: [inflow({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${String(address.port)}` })],
      secretKey: 'seller-binding-secret-at-least-32-bytes',
      realm: 'seller.test',
      transport: paymentHttpTransport(),
    });
    let calls = 0;
    const prices = async (url: string) => {
      calls += 1;
      const tier = new URL(url, 'http://seller.test').searchParams.get('tier');
      await setTimeout(tier === 'premium' ? 1 : 10);
      if (tier === 'error') throw new Error('pricing unavailable');
      if (tier === 'empty') return [];
      if (tier === 'instrument') return [{ amount: '1', currency: 'USD' }];
      if (tier === 'duplicate')
        return [
          { amount: '1', currency: 'USDC' },
          { amount: '2', currency: 'USDC' },
        ];
      return tier === 'premium'
        ? [{ amount: '2', currency: 'USDT' }]
        : [
            { amount: '1', currency: 'USDC' },
            { amount: '1.5', currency: 'USDT' },
          ];
    };
    const fetchHandler = inflowCharges(mppx, async (request) => {
      if (request.method === 'POST' && bodyState === 'unread') {
        const body = (await request.json()) as { tier: string };
        return prices(`/paid?tier=${body.tier}`);
      }
      return prices(request.url);
    });
    const nodeHandler = inflowChargesNodeListener(mppx, (request) => prices(request.url ?? '/'));
    expect(calls).toBe(0);
    const resource = createServer((request, response) => {
      void nodeHandler(request, response)
        .then((result) => {
          if (result.status === 200) {
            events.push('handler');
            response.end('paid content');
          }
        })
        .catch(() => response.writeHead(503).end('Unavailable'));
    });
    resource.listen(0, '127.0.0.1');
    await once(resource, 'listening');
    const resourceAddress = resource.address();
    if (resourceAddress === null || typeof resourceAddress === 'string') throw new Error('Expected TCP listener');
    const origin = `http://127.0.0.1:${String(resourceAddress.port)}`;
    const call = async (tier: string, authorization?: string) => {
      const request = new Request(`${origin}/paid?tier=${tier}`, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ tier }) } : {}),
        headers: authorization === undefined ? {} : { Authorization: authorization },
      });
      if (adapter === 'node') return fetch(request);
      if (bodyState === 'consumed') await request.json();
      const reader = bodyState === 'locked' ? request.body?.getReader() : undefined;
      try {
        const result = await fetchHandler(request);
        expect(request.bodyUsed).toBe(bodyState === 'consumed');
        if (result.status === 402) return result.challenge;
        if (method === 'POST' && bodyState === 'unread') expect(await request.json()).toEqual({ tier });
        events.push('handler');
        return result.withReceipt(new Response('paid content'));
      } catch {
        return new Response('Unavailable', { status: 503 });
      } finally {
        reader?.releaseLock();
      }
    };
    try {
      const [basic, premium] = await Promise.all([call('basic'), call('premium')]);
      expect(basic.status).toBe(402);
      expect(premium.status).toBe(402);
      const basicChallenges = Challenge.fromResponseList(basic);
      const premiumChallenge = Challenge.fromResponse(premium);
      await Promise.all([basic.arrayBuffer(), premium.arrayBuffer()]);
      expect(basicChallenges.map((challenge) => challenge.request)).toMatchObject([
        { amount: '1', currency: 'USDC' },
        { amount: '1.5', currency: 'USDT' },
      ]);
      expect(premiumChallenge.request).toMatchObject({ amount: '2', currency: 'USDT' });
      expect(events).toEqual([]);
      const authorization = Credential.serialize({
        challenge: premiumChallenge,
        source: 'did:inflow:buyer',
        payload: { transactionId: 'test-payment' },
      });
      const wrong = await call('basic', authorization);
      expect(wrong.status).toBe(402);
      await wrong.arrayBuffer();
      expect(events).toEqual([]);
      const paid = await call('premium', authorization);
      expect(paid.status).toBe(200);
      expect(await paid.text()).toBe('paid content');
      expect(paid.headers.has('Payment-Receipt')).toBe(true);
      expect(events).toEqual(['/v1/mpp/validate', '/v1/mpp/broadcast', 'handler']);
      const instrument = await call('instrument');
      expect(instrument.status).toBe(402);
      const instrumentChallenge = Challenge.fromResponse(instrument);
      await instrument.arrayBuffer();
      expect(instrumentChallenge.request).toMatchObject({
        amount: '1',
        currency: 'USD',
        methodDetails: { rail: 'instrument' },
      });
      const instrumentPaid = await call(
        'instrument',
        Credential.serialize({
          challenge: instrumentChallenge,
          source: 'did:inflow:buyer',
          payload: { transactionId: 'test-instrument-payment' },
        }),
      );
      expect(instrumentPaid.status).toBe(200);
      expect(await instrumentPaid.text()).toBe('paid content');
      expect(instrumentPaid.headers.has('Payment-Receipt')).toBe(true);
      expect(events).toEqual([
        '/v1/mpp/validate',
        '/v1/mpp/broadcast',
        'handler',
        '/v1/mpp/validate',
        '/v1/mpp/broadcast',
        'handler',
      ]);
      for (const tier of ['error', 'empty', 'duplicate']) {
        const failed = await call(tier);
        expect(failed.status).toBe(503);
        await failed.arrayBuffer();
      }
      expect(events).toHaveLength(6);
      expect(configHits).toBe(1);
      expect(calls).toBe(9);
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

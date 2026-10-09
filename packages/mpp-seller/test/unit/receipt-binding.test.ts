import { decode, decodeReceipt } from '@inflowpayai/mpp';
import { Challenge, Credential } from 'mppx';
import { Mppx } from 'mppx/server';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { inflow, stripe } from '../../src/methods.server.js';
import { paymentHttpTransport } from '../../src/http-transport.js';

const BASE = 'https://receipt-binding.test';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe.each(['instrument', 'stripe'] as const)('%s receipt binding', (kind) => {
  it.each(['matching', 'wrong-method', 'wrong-challenge', 'missing-challenge'] as const)(
    'handles a %s receipt through the protected route',
    async (scenario) => {
      const name = kind === 'instrument' ? 'inflow' : 'stripe';
      const calls: string[] = [];
      server.use(
        http.get(`${BASE}/v1/mpp/config`, () => {
          calls.push('config');
          return HttpResponse.json({
            sellerId: '22222222-2222-4222-8222-222222222222',
            featureFlags: { idempotencyKeyEnabled: true },
            supportedMethods: [
              {
                id: name,
                supportedCurrencies: ['USD'],
                supportedIntents: ['charge'],
                methodDetails:
                  kind === 'instrument'
                    ? { intentCurrencyRails: { charge: { USD: [{ rail: 'instrument', instrumentId: 'optional' }] } } }
                    : { networkId: 'profile_test', paymentMethodTypes: ['card', 'link'] },
              },
            ],
          });
        }),
        http.post(`${BASE}/v1/mpp/validate`, async ({ request }) => {
          calls.push('validate');
          // The local HTTP fixture receives the SDK's encoded wire credential.
          const body = (await request.json()) as {
            credential: {
              challenge: { method: string; intent: string; request: string };
              payload: unknown;
              source: string;
            };
          };
          return HttpResponse.json({
            success: true,
            ...body,
            challenge: body.credential.challenge,
            details: {},
            request: decode<Record<string, unknown>>(body.credential.challenge.request),
            method: name,
            intent: 'charge',
            source: body.credential.source,
          });
        }),
      );
      const method =
        kind === 'instrument'
          ? inflow({ apiKey: 'test-only', baseUrl: BASE })
          : await stripe({ apiKey: 'test-only', baseUrl: BASE });
      const framework = Mppx.create({
        transport: paymentHttpTransport(),
        methods: [method],
        realm: 'seller.example',
        secretKey: 'test-only-binding-secret-at-least-32-bytes',
      });
      const options = { amount: '1.00', currency: 'USD' };
      const unpaid = await framework.charge(options)(new Request('https://seller.example/item'));
      expect(unpaid.status).toBe(402);
      if (unpaid.status !== 402) throw new Error('Expected payment challenge');
      // Parse the actual challenge returned by the protected route, including its signature.
      const issued = Challenge.fromResponse(unpaid.challenge);
      const expectedReceipt = {
        method: name,
        challengeId: issued.id,
        reference: 'test-payment',
        status: 'success',
        timestamp: '2026-10-03T12:00:00Z',
        settlement: { amount: '1.00', currency: 'USD' },
      };
      const receipt: Record<string, unknown> = { ...expectedReceipt };
      if (scenario === 'wrong-method') receipt['method'] = 'card';
      if (scenario === 'wrong-challenge') receipt['challengeId'] = 'other-challenge';
      if (scenario === 'missing-challenge') delete receipt['challengeId'];
      server.use(
        http.post(`${BASE}/v1/mpp/broadcast`, () => {
          calls.push('broadcast');
          return HttpResponse.json({ receipt });
        }),
      );
      const authorization = Credential.serialize({
        challenge: issued,
        payload:
          kind === 'instrument'
            ? { type: 'instrument', transactionId: 'test-transaction', approvalId: 'test-approval' }
            : { spt: 'spt_test_only' },
        source: 'did:example:buyer',
      });
      const result = await framework.charge(options)(
        new Request('https://seller.example/item', { headers: { Authorization: authorization } }),
      );
      expect(calls).toEqual(['config', 'validate', 'broadcast']);
      if (scenario === 'matching') {
        expect(result.status).toBe(200);
        if (result.status !== 200) throw new Error('Expected successful payment');
        const response = result.withReceipt(new Response('protected content'));
        const header = response.headers.get('Payment-Receipt');
        if (header === null) throw new Error('Expected receipt');
        expect(decodeReceipt(header)).toEqual(expectedReceipt);
        expect(await response.text()).toBe('protected content');
      } else {
        expect(result.status).toBe(402);
        if (result.status !== 402) throw new Error('Unexpected payment success');
        expect(result.challenge.headers.has('Payment-Receipt')).toBe(false);
        expect(result.challenge.status).toBe(500);
        expect(result.challenge.headers.has('WWW-Authenticate')).toBe(false);
        expect(await result.challenge.json()).toMatchObject({
          type: 'https://paymentauth.org/problems/internal-payment-error',
          status: 500,
        });
      }
    },
  );
});

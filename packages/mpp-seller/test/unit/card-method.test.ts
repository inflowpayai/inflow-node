import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';

import { decode, decodeReceipt, encode } from '@inflowpayai/mpp';
import type { CardChargeRequest, MppConfigResponse, MppCredential } from '@inflowpayai/mpp';
import { Challenge, Credential } from 'mppx';
import { Mppx } from 'mppx/server';
import { Mppx as ExpressMppx } from 'mppx/express';
import { Mppx as HonoMppx } from 'mppx/hono';
import express from 'express';
import { Hono } from 'hono';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { card, MppCardUnavailableError, paymentHttpTransport } from '../../src/index.js';
import type { CardSellerParameters } from '../../src/index.js';

const BASE = 'https://mpp.test';
const SECRET = 'seller-binding-secret-at-least-32-bytes';
const publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
const encryptionJwk = { ...publicKey, kid: 'card-key-1', alg: 'RSA-OAEP-256', use: 'enc' };
const methodDetails = {
  recipient: 'acct_seller',
  merchantName: 'Test Seller',
  acceptedNetworks: ['visa'],
  encryptionJwk,
};
const payload = {
  encryptedPayload: 'opaque-encrypted-credential',
  network: 'visa',
  panLastFour: '4242',
  panExpirationMonth: '06',
  panExpirationYear: '2028',
};
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function config(): MppConfigResponse {
  return {
    sellerId: 'seller-1',
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: 'psp' },
    supportedMethods: [
      { id: 'card', label: 'Card', supportedCurrencies: ['USD'], supportedIntents: ['charge'], methodDetails },
    ],
  };
}

function mockConfig(body = config(), origin = BASE) {
  const requests: Request[] = [];
  server.use(
    http.get(`${origin}/v1/mpp/config`, ({ request }) => {
      requests.push(request);
      return HttpResponse.json(body);
    }),
  );
  return requests;
}

function lifecycle(receiptFields: Record<string, unknown> = {}) {
  const calls: { operation: string; credential: MppCredential; key: string | null }[] = [];
  for (const operation of ['validate', 'broadcast']) {
    server.use(
      http.post(`${BASE}/v1/mpp/${operation}`, async ({ request }) => {
        // Requests originate from the real MppClient under test, not external clients.
        const { credential } = (await request.json()) as { credential: MppCredential };
        calls.push({ operation, credential, key: request.headers.get('Idempotency-Key') });
        return HttpResponse.json(
          operation === 'validate'
            ? {
                success: true,
                challenge: credential.challenge,
                credential,
                details: {},
                intent: 'charge',
                method: 'card',
                source: credential.source,
                request: decode<Record<string, unknown>>(credential.challenge.request),
              }
            : {
                receipt: {
                  challengeId: credential.challenge.id,
                  method: 'card',
                  reference: 'pi_test_123',
                  externalId: 'order-123',
                  settlement: { amount: '1.00', currency: 'USD' },
                  status: 'success',
                  timestamp: '2026-10-02T00:00:00Z',
                  ...receiptFields,
                },
              },
        );
      }),
    );
  }
  return calls;
}

async function setup(parameters: Partial<CardSellerParameters> = {}) {
  const method = await card({ apiKey: 'seller-key', baseUrl: BASE, ...parameters });
  return { method, mppx: Mppx.create({ methods: [method], realm: 'seller.test', secretKey: SECRET }) };
}

describe('CARD seller', () => {
  it.each([undefined, 'sandbox'] as const)('authenticates against environment %s', async (environment) => {
    const requests = mockConfig(
      config(),
      environment === 'sandbox' ? 'https://sandbox.inflowpay.ai' : 'https://api.inflowpay.ai',
    );
    await card({ apiKey: 'seller-key', ...(environment === undefined ? {} : { environment }) });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('X-API-KEY')).toBe('seller-key');
  });

  it('uses the supplied transport and caches configuration while keeping offers independent', async () => {
    const requests = mockConfig();
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => globalThis.fetch(input, init));
    const { mppx } = await setup({ fetch, timeoutMs: 5000, environment: 'sandbox' });
    const first = await mppx.challenge.card.charge({ amount: '1.25', billingRequired: true });
    // mppx types generated challenges generically; this request was created by the CARD schema above.
    const firstRequest = first.request as CardChargeRequest;
    firstRequest.methodDetails.acceptedNetworks.push('visa');
    firstRequest.methodDetails.encryptionJwk.kid = 'mutated';
    const second = await mppx.challenge.card.charge({ amount: '1' });
    expect(second.request).toEqual({
      amount: '100',
      currency: 'usd',
      recipient: 'acct_seller',
      methodDetails: {
        merchantName: 'Test Seller',
        acceptedNetworks: ['visa'],
        encryptionJwk,
      },
    });
    expect(requests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(firstRequest.amount).toBe('125');
    expect(firstRequest.methodDetails.billingRequired).toBe(true);
  });

  it.each(['0.50', '1', '1.2', '1.25', '999999.99'])('converts dollars %s to exact cents', async (amount) => {
    mockConfig();
    const { mppx } = await setup();
    const challenge = await mppx.challenge.card.charge({ amount });
    expect(challenge.request['amount']).toBe(String(Math.round(Number(amount) * 100)));
    expect(challenge.expires).toBeDefined();
    expect(challenge.request).not.toHaveProperty('expires');
  });

  it.each(['0', '0.49', '-1', '0.501', '1e2', '01', '1000000', 'NaN', ' 1'])(
    'rejects invalid price %s',
    async (amount) => {
      mockConfig();
      const { mppx } = await setup();
      await expect(mppx.challenge.card.charge({ amount })).rejects.toThrow();
    },
  );

  it.each(['absent', 'currency', 'intent', 'details', 'recipient', 'key', 'networks'] as const)(
    'rejects unavailable configuration: %s',
    async (field) => {
      const value = config();
      const capability = value.supportedMethods[0];
      if (!capability) throw new Error('missing fixture capability');
      if (field === 'absent') value.supportedMethods = [];
      else if (field === 'currency') capability.supportedCurrencies = ['EUR'];
      else if (field === 'intent') capability.supportedIntents = ['subscription'];
      else if (field === 'details') delete capability.methodDetails;
      else
        capability.methodDetails = {
          ...methodDetails,
          [field === 'key' ? 'encryptionJwk' : field === 'networks' ? 'acceptedNetworks' : field]: undefined,
        };
      mockConfig(value);
      await expect(setup()).rejects.toBeInstanceOf(MppCardUnavailableError);
    },
  );

  it('pins merchant and key configuration in challenges and offer policy', async () => {
    mockConfig();
    const canOffer = vi.fn<NonNullable<CardSellerParameters['canOffer']>>(() => true);
    const { method, mppx } = await setup({ canOffer });
    const options = {
      amount: '1.00',
      recipient: 'acct_attacker',
      methodDetails: {
        acceptedNetworks: ['visa' as const],
        merchantName: 'Attacker',
        encryptionJwk: {
          kty: 'RSA' as const,
          use: 'enc' as const,
          alg: 'RSA-OAEP-256' as const,
          kid: 'attacker',
          n: 'attacker',
          e: 'AQAB',
        },
      },
    };
    const result = await mppx.compose([method, options])(new Request('https://seller.test/paid'));
    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected challenge');
    const challenge = Challenge.fromResponse(result.challenge);
    expect(challenge.request).toMatchObject({
      amount: '100',
      currency: 'usd',
      recipient: 'acct_seller',
      methodDetails: { encryptionJwk, merchantName: 'Test Seller' },
    });
    expect(canOffer.mock.calls[0]?.[0].request).toEqual(challenge.request);
    expect(options.recipient).toBe('acct_attacker');
  });

  it('allows the seller to omit CARD offers', async () => {
    mockConfig();
    const { method, mppx } = await setup({ canOffer: () => false });
    await expect(mppx.compose([method, { amount: '1' }])(new Request('https://seller.test/paid'))).rejects.toThrow(
      'No payment offers',
    );
  });

  it.each([undefined, 'did:example:buyer'])(
    'validates then broadcasts external credentials with source %s',
    async (source) => {
      mockConfig();
      const calls = lifecycle();
      const { mppx } = await setup();
      const options = { amount: '1.00', externalId: 'order-123' };
      const challenge = await mppx.challenge.card.charge(options);
      const completePayload = {
        ...payload,
        extension: 'preserved',
        billingAddress: { zip: '94102', countryCode: 'US' },
      };
      const authorization = Credential.serialize({
        challenge,
        payload: completePayload,
        ...(source === undefined ? {} : { source }),
      });
      const result = await mppx.charge(options)(
        new Request('https://seller.test/paid', { headers: { Authorization: authorization } }),
      );
      expect(result.status).toBe(200);
      if (result.status !== 200) throw new Error('expected success');
      const response = result.withReceipt(new Response('paid content'));
      expect(decodeReceipt(response.headers.get('Payment-Receipt') ?? '')).toMatchObject({
        method: 'card',
        challengeId: challenge.id,
        reference: 'pi_test_123',
        externalId: 'order-123',
        settlement: { amount: '1.00', currency: 'USD' },
      });
      expect(calls.map((call) => call.operation)).toEqual(['validate', 'broadcast']);
      expect(calls[1]?.credential).toEqual({
        challenge: { ...challenge, request: encode(challenge.request) },
        payload: completePayload,
        source: source ?? '',
      });
      expect(calls[1]?.key).toMatch(/^[a-f0-9-]{36}$/);
    },
  );

  it.each(['hmac', 'price', 'order', 'expired'] as const)(
    'rejects %s mismatches before provider calls',
    async (change) => {
      mockConfig();
      const calls = lifecycle();
      const { mppx } = await setup();
      const challenge = await mppx.challenge.card.charge({
        amount: '1',
        externalId: 'original',
        ...(change === 'expired' ? { expires: '2020-01-01T00:00:00Z' } : {}),
      });
      if (change === 'hmac') challenge.request['recipient'] = 'acct_attacker';
      const authorization = Credential.serialize({ challenge, payload });
      const result = await mppx.charge({
        amount: change === 'price' ? '2' : '1',
        externalId: change === 'order' ? 'other' : 'original',
      })(new Request('https://seller.test/paid', { headers: { Authorization: authorization } }));
      expect(result.status).toBe(402);
      expect(calls).toEqual([]);
    },
  );

  it.each(['validate', 'broadcast'])('does not release content when %s fails', async (operation) => {
    mockConfig();
    const calls = lifecycle();
    server.use(
      http.post(`${BASE}/v1/mpp/${operation}`, () =>
        HttpResponse.json({
          problem: {
            type: 'https://paymentauth.org/problems/payment-failed',
            title: 'Payment failed',
            status: 402,
            detail: 'Stripe is disconnected.',
          },
        }),
      ),
    );
    const { mppx } = await setup();
    const challenge = await mppx.challenge.card.charge({ amount: '1' });
    const result = await mppx.charge({ amount: '1' })(
      new Request('https://seller.test/paid', {
        headers: { Authorization: Credential.serialize({ challenge, payload }) },
      }),
    );
    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected failure');
    expect(await result.challenge.json()).toMatchObject({ detail: 'Stripe is disconnected.' });
    expect(result.challenge.headers.has('Payment-Receipt')).toBe(false);
    expect(calls.map((call) => call.operation)).toEqual(operation === 'validate' ? [] : ['validate']);
  });

  it.each([{ method: 'stripe' }, { challengeId: undefined }, { challengeId: 'other' }])(
    'rejects mismatched receipt %j',
    async (fields) => {
      mockConfig();
      lifecycle(fields);
      const { mppx } = await setup();
      const challenge = await mppx.challenge.card.charge({ amount: '1' });
      await expect(mppx.broadcastCredential({ challenge, payload })).rejects.toThrow('malformed');
    },
  );

  it.each(['Express', 'Hono'] as const)('gates a real %s handler and attaches its receipt', async (framework) => {
    mockConfig();
    const calls = lifecycle();
    const method = await card({ apiKey: 'seller-key', baseUrl: BASE });
    let contentCalls = 0;
    let request: (path: string, authorization?: string) => Promise<Response>;
    let close = async () => {};
    if (framework === 'Express') {
      server.use(http.get(/^http:\/\/127\.0\.0\.1:/, () => passthrough()));
      const payments = ExpressMppx.create({ methods: [method], secretKey: SECRET, transport: paymentHttpTransport() });
      const app = express();
      for (const path of ['/paid', '/other'])
        app.get(path, payments.charge({ amount: '1.00', scope: `GET ${path}` }), (_request, response) => {
          contentCalls += 1;
          response.json({ access: 'granted' });
        });
      const listener = app.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP address');
      request = (path, authorization) =>
        fetch(`http://127.0.0.1:${String(address.port)}${path}`, {
          headers: authorization === undefined ? {} : { Authorization: authorization },
        });
      close = async () => {
        const closed = once(listener, 'close');
        listener.close();
        listener.closeAllConnections();
        await closed;
      };
    } else {
      const payments = HonoMppx.create({ methods: [method], secretKey: SECRET, transport: paymentHttpTransport() });
      const app = new Hono();
      for (const path of ['/paid', '/other'])
        app.get(path, payments.charge({ amount: '1.00' }), (context) => {
          contentCalls += 1;
          return context.json({ access: 'granted' });
        });
      request = async (path, authorization) =>
        app.request(`https://seller.test${path}`, {
          headers: authorization === undefined ? {} : { Authorization: authorization },
        });
    }
    try {
      const unpaid = await request('/paid');
      expect(unpaid.status).toBe(402);
      const challenge = Challenge.fromResponse(unpaid);
      await unpaid.text();
      expect(contentCalls).toBe(0);
      const authorization = Credential.serialize({ challenge, payload });
      const wrongRoute = await request('/other', authorization);
      expect(wrongRoute.status).toBe(402);
      await wrongRoute.text();
      expect(calls).toEqual([]);
      const paid = await request('/paid', authorization);
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ access: 'granted' });
      expect(decodeReceipt(paid.headers.get('Payment-Receipt') ?? '')).toMatchObject({
        challengeId: challenge.id,
        method: 'card',
      });
      expect(contentCalls).toBe(1);
      expect(calls.map((call) => call.operation)).toEqual(['validate', 'broadcast']);
      server.use(http.post(`${BASE}/v1/mpp/broadcast`, () => HttpResponse.json({})));
      const failed = await request('/paid', authorization);
      expect(failed.status).toBe(500);
      expect(failed.headers.has('WWW-Authenticate')).toBe(false);
      expect(failed.headers.has('Payment-Receipt')).toBe(false);
      expect(failed.headers.get('Cache-Control')).toBe('no-store');
      expect(await failed.json()).toMatchObject({
        status: 500,
        type: 'https://paymentauth.org/problems/internal-payment-error',
      });
      expect(contentCalls).toBe(1);
    } finally {
      await close();
    }
  });
});

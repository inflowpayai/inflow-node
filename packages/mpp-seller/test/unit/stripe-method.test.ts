import { decode, decodeReceipt, encode, parseChallengeHeader } from '@inflowpayai/mpp';
import type { MppConfigResponse } from '@inflowpayai/mpp';
import { Credential, Receipt } from 'mppx';
import { Mppx } from 'mppx/server';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MppStripeAmountError, MppStripeRequestError, MppStripeUnavailableError } from '../../src/errors.js';
import { stripe } from '../../src/methods.server.js';
import type { StripeSellerParameters } from '../../src/methods.server.js';

const BASE = 'https://mpp.test';
const NETWORK_ID = 'profile_test_seller';
const SECRET = 'seller-binding-secret-at-least-32-bytes';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function config(overrides: Partial<MppConfigResponse> = {}): MppConfigResponse {
  return {
    sellerId: '22222222-2222-2222-2222-222222222222',
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: 'psp' },
    supportedMethods: [
      {
        id: 'stripe',
        label: 'Stripe',
        methodDetails: { networkId: NETWORK_ID, paymentMethodTypes: ['card', 'link'] },
        supportedCurrencies: ['USD'],
        supportedIntents: ['charge'],
      },
    ],
    ...overrides,
  };
}

function mockConfig(body: MppConfigResponse = config(), onHit?: () => void): void {
  server.use(
    http.get(`${BASE}/v1/mpp/config`, () => {
      onHit?.();
      return HttpResponse.json(body);
    }),
  );
}

async function makeMppx() {
  const method = await stripe({ apiKey: 'sk_test', baseUrl: BASE });
  return { method, mppx: Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET }) };
}

function requestFrom(response: Response): Record<string, unknown> {
  const header = response.headers.get('WWW-Authenticate');
  if (header === null) throw new Error('expected WWW-Authenticate header');
  return decode(parseChallengeHeader(header).request);
}

function mockLifecycle(): {
  broadcastBody(): unknown;
  idempotencyKey(): string | null;
  order: string[];
} {
  let body: unknown;
  let idempotencyKey: string | null = null;
  const order: string[] = [];
  server.use(
    http.post(`${BASE}/v1/mpp/validate`, async ({ request }) => {
      order.push('validate');
      const submitted = (await request.json()) as {
        credential: {
          challenge: { intent: string; method: string; request: string };
          payload: unknown;
          source: string;
        };
      };
      return HttpResponse.json({
        challenge: submitted.credential.challenge,
        credential: submitted.credential,
        details: { provider: 'stripe' },
        intent: submitted.credential.challenge.intent,
        method: submitted.credential.challenge.method,
        request: decode<Record<string, unknown>>(submitted.credential.challenge.request),
        source: submitted.credential.source,
        success: true,
      });
    }),
    http.post(`${BASE}/v1/mpp/broadcast`, async ({ request }) => {
      order.push('broadcast');
      body = await request.json();
      idempotencyKey = request.headers.get('Idempotency-Key');
      return HttpResponse.json({
        receipt: {
          challengeId: 'stripe-challenge',
          method: 'stripe',
          reference: 'pi_test_123',
          settlement: { amount: '1.00', currency: 'USD' },
          status: 'success',
          timestamp: '2026-09-20T00:00:00Z',
        },
      });
    }),
  );
  return { broadcastBody: () => body, idempotencyKey: () => idempotencyKey, order };
}

describe('Stripe seller method', () => {
  it.each([
    [undefined, 'https://api.inflowpay.ai'],
    ['sandbox', 'https://sandbox.inflowpay.ai'],
  ] as const)(
    'loads the authenticated config for environment %s without a base URL override',
    async (environment, origin) => {
      const requests: Request[] = [];
      server.use(
        http.get(`${origin}/v1/mpp/config`, ({ request }) => {
          requests.push(request);
          return HttpResponse.json(config());
        }),
      );

      const method = await stripe({
        apiKey: 'inflow-seller-key',
        ...(environment !== undefined ? { environment } : {}),
      });
      const mppx = Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET });
      const challenge = await mppx.challenge.stripe.charge({ amount: '1' });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get('X-API-KEY')).toBe('inflow-seller-key');
      expect(challenge.request).toMatchObject({ methodDetails: { networkId: NETWORK_ID } });
    },
  );

  it('uses the supplied fetch and base URL instead of the environment URL', async () => {
    mockConfig();
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => globalThis.fetch(input, init));
    const method = await stripe({
      apiKey: 'inflow-seller-key',
      baseUrl: BASE,
      environment: 'sandbox',
      fetch,
      timeoutMs: 5_000,
    });
    const mppx = Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET });

    await mppx.challenge.stripe.charge({ amount: '1' });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${BASE}/v1/mpp/config`);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts config requests at the supplied timeout and reports the timeout after bounded retries', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error('expected request abort signal'));
            return;
          }
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new Error('aborted', { cause: signal.reason })), {
            once: true,
          });
        }),
    );

    await expect(stripe({ apiKey: 'inflow-seller-key', baseUrl: BASE, fetch, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('uses the server-authoritative profile with the official mppx Stripe charge schema', async () => {
    let configHits = 0;
    mockConfig(config(), () => (configHits += 1));
    const { mppx } = await makeMppx();
    const result = await mppx.charge({
      amount: '1.25',
      currency: 'eur',
      decimals: 3,
      networkId: 'caller-profile',
      paymentMethodTypes: ['caller-method'],
      description: 'Widget',
      externalId: 'order-123',
      metadata: { campaign: 'agents' },
    })(new Request('https://app.test/widgets'));

    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(requestFrom(result.challenge)).toEqual({
      amount: '125',
      currency: 'usd',
      externalId: 'order-123',
      methodDetails: {
        metadata: { campaign: 'agents' },
        networkId: NETWORK_ID,
        paymentMethodTypes: ['card', 'link'],
      },
    });
    expect(configHits).toBe(1);
  });

  it('fails at initialization when Stripe is not safely advertised for the seller', async () => {
    mockConfig(config({ supportedMethods: [] }));
    await expect(stripe({ apiKey: 'sk_test', baseUrl: BASE })).rejects.toBeInstanceOf(MppStripeUnavailableError);
  });

  it.each([
    [undefined, 'missing method details'],
    [{ paymentMethodTypes: ['card'] }, 'missing network id'],
    [{ networkId: 123, paymentMethodTypes: ['card'] }, 'non-string network id'],
    [{ networkId: '', paymentMethodTypes: ['card'] }, 'blank network id'],
    [{ networkId: '   ', paymentMethodTypes: ['card'] }, 'whitespace network id'],
    [{ networkId: NETWORK_ID }, 'missing payment method list'],
    [{ networkId: NETWORK_ID, paymentMethodTypes: 'card' }, 'non-array payment method list'],
    [{ networkId: NETWORK_ID, paymentMethodTypes: [] }, 'empty payment method list'],
    [{ networkId: NETWORK_ID, paymentMethodTypes: ['  '] }, 'blank payment method'],
    [{ networkId: NETWORK_ID, paymentMethodTypes: ['card', 1] }, 'non-string payment method'],
  ])('fails closed for malformed Stripe capability details: %s', async (methodDetails, _description) => {
    mockConfig(
      config({
        supportedMethods: [
          {
            id: 'stripe',
            label: 'Stripe',
            ...(methodDetails !== undefined ? { methodDetails } : {}),
            supportedCurrencies: ['USD'],
            supportedIntents: ['charge'],
          },
        ],
      }),
    );
    await expect(stripe({ apiKey: 'sk_test', baseUrl: BASE })).rejects.toBeInstanceOf(MppStripeUnavailableError);
  });

  it.each([
    [['EUR'], ['charge'], 'missing USD capability'],
    [['USD'], ['subscription'], 'missing charge capability'],
  ])('fails closed for %s / %s: %s', async (supportedCurrencies, supportedIntents, _description) => {
    mockConfig(
      config({
        supportedMethods: [
          {
            id: 'stripe',
            label: 'Stripe',
            methodDetails: { networkId: NETWORK_ID, paymentMethodTypes: ['card'] },
            supportedCurrencies,
            supportedIntents,
          },
        ],
      }),
    );
    await expect(stripe({ apiKey: 'sk_test', baseUrl: BASE })).rejects.toBeInstanceOf(MppStripeUnavailableError);
  });

  it.each([
    ['0', 'USD amount must be at least 0.50'],
    ['0.49', 'USD amount must be at least 0.50'],
    ['0.501', 'USD amount must be a decimal with at most two fractional digits'],
    ['1000000', 'USD amount must not exceed 999999.99'],
    ['00.50', 'USD amount must be a decimal with at most two fractional digits'],
  ])('rejects the non-conforming USD amount %s with an actionable error', async (amount, reason) => {
    mockConfig();
    const { mppx } = await makeMppx();
    await expect(mppx.charge({ amount })(new Request('https://app.test/widgets'))).rejects.toThrow(
      new MppStripeAmountError(reason),
    );
  });

  it.each([
    ['0.50', '50'],
    ['0.5', '50'],
    ['1', '100'],
    ['999999.99', '99999999'],
  ])('accepts USD amount %s as exactly %s cents', async (amount, cents) => {
    mockConfig();
    const { mppx } = await makeMppx();
    const result = await mppx.charge({ amount })(new Request('https://app.test/widgets'));
    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(requestFrom(result.challenge)['amount']).toBe(cents);
  });

  it('rejects malformed amount syntax through the foundation schema', async () => {
    mockConfig();
    const { mppx } = await makeMppx();
    expect(() => mppx.charge({ amount: '-1' })).toThrow('Invalid amount');
  });

  it.each([
    [{ externalId: 'x'.repeat(256) }, 'externalId must be at most 255 characters'],
    [{ metadata: { externalId: 'order-123' } }, 'metadata key "externalId" is invalid or reserved'],
    [
      { metadata: Object.fromEntries(Array.from({ length: 46 }, (_value, index) => [`key${index}`, 'value'])) },
      'metadata may contain at most 45 entries',
    ],
    [{ metadata: { 'bad[key]': 'value' } }, 'metadata key "bad[key]" is invalid or reserved'],
    [{ metadata: { 'bad]key': 'value' } }, 'metadata key "bad]key" is invalid or reserved'],
    [{ metadata: { ' ': 'value' } }, 'metadata key " " is invalid or reserved'],
    [{ metadata: { ['k'.repeat(41)]: 'value' } }, `metadata key "${'k'.repeat(41)}" is invalid or reserved`],
    [
      { metadata: { campaign: 'x'.repeat(501) } },
      'metadata value for "campaign" must be a string of at most 500 characters',
    ],
  ])('rejects Stripe request fields that the buyer or PSP cannot accept: %s', async (request, reason) => {
    mockConfig();
    const { mppx } = await makeMppx();
    await expect(mppx.charge({ amount: '1.00', ...request })(new Request('https://app.test/widgets'))).rejects.toThrow(
      new MppStripeRequestError(reason),
    );
  });

  it.each(['inflowMppTransactionId', 'mppChallengeId', 'mppIntent', 'mppMethod', 'stripeNetworkProfile'])(
    'rejects reserved metadata key %s',
    async (key) => {
      mockConfig();
      const { mppx } = await makeMppx();

      await expect(
        mppx.charge({ amount: '1.00', metadata: { [key]: 'value' } })(new Request('https://app.test/widgets')),
      ).rejects.toThrow(new MppStripeRequestError(`metadata key "${key}" is invalid or reserved`));
    },
  );

  it('preserves metadata and the seller reference at their exact length and count limits', async () => {
    mockConfig();
    const { mppx } = await makeMppx();
    const metadata = {
      ...Object.fromEntries(Array.from({ length: 44 }, (_value, index) => [`key${index}`, 'value'])),
      ['k'.repeat(40)]: 'v'.repeat(500),
    };
    const externalId = 'r'.repeat(255);
    const result = await mppx.charge({ amount: '1', externalId, metadata })(new Request('https://app.test/widgets'));

    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(requestFrom(result.challenge)).toMatchObject({ externalId, methodDetails: { metadata } });
  });

  it('binds provider destination, payment types, metadata, and seller reconciliation fields', async () => {
    mockConfig();
    const { method } = await makeMppx();
    expect(
      method.stableBinding?.({
        amount: '100',
        currency: 'usd',
        externalId: 'order-123',
        methodDetails: {
          metadata: { campaign: 'agents' },
          networkId: NETWORK_ID,
          paymentMethodTypes: ['card', 'link'],
        },
      }),
    ).toEqual({
      amount: '100',
      currency: 'usd',
      externalId: 'order-123',
      methodDetails: {
        metadata: { campaign: 'agents' },
        networkId: NETWORK_ID,
        paymentMethodTypes: ['card', 'link'],
      },
      recipient: undefined,
    });
  });

  it('validates before broadcast and returns the authoritative Stripe receipt', async () => {
    mockConfig();
    const lifecycle = mockLifecycle();
    const { mppx } = await makeMppx();
    const challenge = await mppx.challenge.stripe.charge({ amount: '1.00', externalId: 'order-123' });
    const authorization = Credential.serialize({
      challenge,
      payload: { externalId: 'order-123', spt: 'spt_test_123' },
    });
    const result = await mppx.charge({ amount: '1.00', externalId: 'order-123' })(
      new Request('https://app.test/widgets', { headers: { Authorization: authorization } }),
    );

    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error('expected 200');
    expect(lifecycle.order).toEqual(['validate', 'broadcast']);
    expect(lifecycle.idempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
    expect(lifecycle.broadcastBody()).toMatchObject({
      credential: {
        challenge: { intent: 'charge', method: 'stripe' },
        payload: { externalId: 'order-123', spt: 'spt_test_123' },
        source: '',
      },
    });

    const response = result.withReceipt(new Response('ok'));
    const receipt = Receipt.fromResponse(response);
    expect(receipt).toMatchObject({ method: 'stripe', reference: 'pi_test_123', status: 'success' });
    const header = response.headers.get('Payment-Receipt');
    if (header === null) throw new Error('expected Payment-Receipt header');
    expect(decodeReceipt(header)).toMatchObject({
      method: 'stripe',
      reference: 'pi_test_123',
      settlement: { amount: '1.00', currency: 'USD' },
    });
  });

  it.each([undefined, '', 'different-order'])(
    'rejects credential reference %s when the seller specifies a reference',
    async (externalId) => {
      mockConfig();
      const lifecycle = mockLifecycle();
      const { mppx } = await makeMppx();
      const options = { amount: '1.00', externalId: 'order-123' };
      const challenge = await mppx.challenge.stripe.charge(options);
      const authorization = Credential.serialize({
        challenge,
        payload: { spt: 'spt_test_123', ...(externalId !== undefined ? { externalId } : {}) },
      });

      const result = await mppx.charge(options)(
        new Request('https://app.test/widgets', { headers: { Authorization: authorization } }),
      );

      expect(result.status).toBe(402);
      if (result.status !== 402) throw new Error('expected 402');
      expect(await result.challenge.json()).toMatchObject({
        type: 'https://paymentauth.org/problems/invalid-challenge',
      });
      expect(result.challenge.headers.get('Payment-Receipt')).toBeNull();
      expect(lifecycle.order).toEqual([]);
    },
  );

  it('retains the credential source in standalone validation without broadcasting a payment', async () => {
    mockConfig();
    const lifecycle = mockLifecycle();
    const { mppx } = await makeMppx();
    const challenge = await mppx.challenge.stripe.charge({ amount: '1.00' });
    const credential = { challenge, payload: { spt: 'spt_test_123' }, source: 'did:example:buyer' };

    const result = await mppx.validateCredential(credential);

    expect(result).toMatchObject({ credential, details: { provider: 'stripe' }, source: credential.source });
    expect(lifecycle.order).toEqual(['validate']);
  });

  it.each([
    { amount: '2.00', externalId: 'order-123' },
    { amount: '1.00', externalId: 'different-order' },
    { amount: '1.00', externalId: 'order-123', metadata: { purpose: 'different' } },
  ])('rejects a credential issued for different route terms: %s', async (options) => {
    mockConfig();
    const lifecycle = mockLifecycle();
    const { mppx } = await makeMppx();
    const challenge = await mppx.challenge.stripe.charge({ amount: '1.00', externalId: 'order-123' });
    const authorization = Credential.serialize({
      challenge,
      payload: { spt: 'spt_test_123', externalId: 'order-123' },
    });

    const result = await mppx.charge(options)(
      new Request('https://app.test/widgets', { headers: { Authorization: authorization } }),
    );

    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(result.challenge.headers.get('Payment-Receipt')).toBeNull();
    expect(lifecycle.order).toEqual([]);
  });

  it.each([
    ['validate', 402, 'verification-failed', 'Verification Failed'],
    ['broadcast', 402, 'verification-failed', 'Verification Failed'],
    ['broadcast', 503, 'settlement-unavailable', 'Settlement Pending'],
  ] as const)(
    'preserves the %s payment failure with HTTP %s and no receipt',
    async (operation, status, type, title) => {
      mockConfig();
      const lifecycle = mockLifecycle();
      const problem = {
        type: `https://paymentauth.org/problems/${type}`,
        title,
        status,
        detail: 'Stripe payment outcome.',
      };
      server.use(
        http.post(`${BASE}/v1/mpp/${operation}`, () => {
          lifecycle.order.push(operation);
          return HttpResponse.json({ problem, ...(operation === 'validate' ? { success: false } : {}) });
        }),
      );
      const { mppx } = await makeMppx();
      const challenge = await mppx.challenge.stripe.charge({ amount: '1.00' });
      const authorization = Credential.serialize({ challenge, payload: { spt: 'spt_test_123' } });

      const result = await mppx.charge({ amount: '1.00' })(
        new Request('https://app.test/widgets', { headers: { Authorization: authorization } }),
      );

      expect(result.status).toBe(402);
      if (result.status !== 402) throw new Error('expected challenge response');
      expect(result.challenge.status).toBe(status);
      expect(await result.challenge.json()).toMatchObject(problem);
      expect(result.challenge.headers.get('Payment-Receipt')).toBeNull();
      expect(lifecycle.order).toEqual(operation === 'validate' ? ['validate'] : ['validate', 'broadcast']);
    },
  );

  it.each(['validateCredential', 'broadcastCredential'] as const)(
    'rejects mismatched references through standalone %s',
    async (operation) => {
      mockConfig();
      const lifecycle = mockLifecycle();
      const { mppx } = await makeMppx();
      const challenge = await mppx.challenge.stripe.charge({ amount: '1.00', externalId: 'order-123' });

      await expect(
        mppx[operation]({ challenge, payload: { spt: 'spt_test_123', externalId: 'different-order' } }),
      ).rejects.toThrow('credential externalId does not match the challenge reference');
      expect(lifecycle.order).toEqual([]);
    },
  );

  it.each([
    [undefined, undefined],
    [undefined, 'buyer-reference'],
    ['', ''],
  ])('accepts challenge reference %s and credential reference %s', async (sellerReference, buyerReference) => {
    mockConfig();
    const lifecycle = mockLifecycle();
    const { mppx } = await makeMppx();
    const options = { amount: '1.00', ...(sellerReference !== undefined ? { externalId: sellerReference } : {}) };
    const challenge = await mppx.challenge.stripe.charge(options);
    const authorization = Credential.serialize({
      challenge,
      payload: { spt: 'spt_test_123', ...(buyerReference !== undefined ? { externalId: buyerReference } : {}) },
    });

    const result = await mppx.charge(options)(
      new Request('https://app.test/widgets', { headers: { Authorization: authorization } }),
    );

    expect(result.status).toBe(200);
    expect(lifecycle.order).toEqual(['validate', 'broadcast']);
  });

  it('uses the same authoritative offer for canOffer, challenges, and payment dispatch', async () => {
    mockConfig();
    const lifecycle = mockLifecycle();
    const expectedRequest = {
      amount: '100',
      currency: 'usd',
      externalId: 'order-123',
      methodDetails: { networkId: NETWORK_ID, paymentMethodTypes: ['card', 'link'] },
    };
    const canOffer = vi.fn<NonNullable<StripeSellerParameters['canOffer']>>(
      ({ request }) =>
        request.amount === expectedRequest.amount &&
        request.currency === expectedRequest.currency &&
        request.methodDetails.networkId === NETWORK_ID &&
        request.methodDetails.paymentMethodTypes.join(',') === 'card,link',
    );
    const method = await stripe({ apiKey: 'sk_test', baseUrl: BASE, canOffer });
    const mppx = Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET });
    const options = {
      amount: '1.00',
      currency: 'eur',
      decimals: 3,
      externalId: 'order-123',
      networkId: 'caller-profile',
      paymentMethodTypes: ['caller-method'],
    };
    const handler = mppx.compose([method, options]);
    const unpaid = await handler(new Request('https://app.test/widgets'));
    expect(unpaid.status).toBe(402);
    if (unpaid.status !== 402) throw new Error('expected 402');
    expect(requestFrom(unpaid.challenge)).toEqual(expectedRequest);
    expect(canOffer).toHaveBeenCalledOnce();
    expect(canOffer.mock.calls[0]?.[0].request).toEqual(expectedRequest);

    const challenge = await mppx.challenge.stripe.charge(options);
    expect(challenge.request).toEqual(expectedRequest);
    const authorization = Credential.serialize({
      challenge,
      payload: { externalId: 'order-123', spt: 'spt_test_123' },
    });
    const paid = await handler(new Request('https://app.test/widgets', { headers: { Authorization: authorization } }));
    expect(paid.status).toBe(200);
    expect(lifecycle.order).toEqual(['validate', 'broadcast']);
    expect(lifecycle.broadcastBody()).toMatchObject({
      credential: { challenge: { request: encode(expectedRequest) } },
    });
    expect(canOffer).toHaveBeenCalledOnce();
  });

  it('omits a composed Stripe offer when canOffer rejects it', async () => {
    mockConfig();
    const method = await stripe({ apiKey: 'sk_test', baseUrl: BASE, canOffer: () => false });
    const mppx = Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET });
    await expect(mppx.compose([method, { amount: '1.00' }])(new Request('https://app.test/widgets'))).rejects.toThrow(
      'No payment offers are available for this request',
    );
  });
});

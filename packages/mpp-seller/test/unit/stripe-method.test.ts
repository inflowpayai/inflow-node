import { decode, decodeReceipt, parseChallengeHeader } from '@inflowpayai/mpp';
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
    [{ networkId: '', paymentMethodTypes: ['card'] }, 'blank network id'],
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
            methodDetails,
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

  it('accepts the exact $0.50 minimum', async () => {
    mockConfig();
    const { mppx } = await makeMppx();
    const result = await mppx.charge({ amount: '0.50' })(new Request('https://app.test/widgets'));
    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(requestFrom(result.challenge)['amount']).toBe('50');
  });

  it.each([
    [{ externalId: 'x'.repeat(256) }, 'externalId must be at most 255 characters'],
    [{ metadata: { externalId: 'order-123' } }, 'metadata key "externalId" is invalid or reserved'],
    [
      { metadata: Object.fromEntries(Array.from({ length: 46 }, (_value, index) => [`key${index}`, 'value'])) },
      'metadata may contain at most 45 entries',
    ],
    [{ metadata: { 'bad[key]': 'value' } }, 'metadata key "bad[key]" is invalid or reserved'],
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

  it('binds provider destination, payment types, metadata, and seller reconciliation fields', async () => {
    mockConfig();
    const { method } = await makeMppx();
    expect(
      method.stableBinding?.({
        amount: '100',
        currency: 'usd',
        description: 'Widget',
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
      description: 'Widget',
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

  it('passes the transformed request to canOffer', async () => {
    mockConfig();
    const canOffer = vi.fn<NonNullable<StripeSellerParameters['canOffer']>>(
      ({ request }) => request.amount === '100' && request.currency === 'usd',
    );
    const method = await stripe({ apiKey: 'sk_test', baseUrl: BASE, canOffer });
    const mppx = Mppx.create({ methods: [method], realm: 'app.test', secretKey: SECRET });
    await mppx.compose([method, { amount: '1.00' }])(new Request('https://app.test/widgets'));
    expect(canOffer).toHaveBeenCalledOnce();
  });
});

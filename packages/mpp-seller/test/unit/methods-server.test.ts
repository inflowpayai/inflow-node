import { decode, decodeReceipt, parseChallengeHeader } from '@inflowpayai/mpp';
import type { MppConfigResponse } from '@inflowpayai/mpp';
import { Credential, Receipt } from 'mppx';
import { Mppx } from 'mppx/server';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  MppAmbiguousRailError,
  MppInstrumentRequiredError,
  MppRedeemProblemError,
  MppUnsupportedCurrencyError,
  MppUnsupportedRailError,
} from '../../src/errors.js';
import { inflow, tempo } from '../../src/methods.server.js';
import type { InflowSellerParameters, TempoSellerParameters } from '../../src/types.js';

const BASE = 'https://mpp.test';
const UUID = '11111111-1111-1111-1111-111111111111';
const SELLER = '22222222-2222-2222-2222-222222222222';
const INSTRUMENT = '33333333-3333-3333-3333-333333333333';
const SECRET = 'seller-binding-secret-at-least-32-bytes';
const TEMPO_ASSET = '0x20c0000000000000000000000000000000000000';
const TEMPO_RECIPIENT = '0x2222222222222222222222222222222222222222';
const TEMPO_SPLIT_RECIPIENT = '0x3333333333333333333333333333333333333333';
const TEMPO_MEMO = '0x0000000000000000000000000000000000000000000000000000000000001234';
const server = setupServer();

// The `mppx.challenge.*` generator returns a loosely-typed Challenge (request: Record, intent/method: string), so
// hand-built credentials need a cast to the strict VerifyContext the `inflow` method's verify hook expects.
type VerifyArg = Parameters<ReturnType<typeof inflow>['verify']>[0];

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function config(overrides: Partial<MppConfigResponse> = {}): MppConfigResponse {
  return {
    sellerId: SELLER,
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: 'psp' },
    supportedMethods: [
      {
        id: 'inflow',
        label: 'InFlow',
        methodDetails: {
          intentCurrencyRails: {
            charge: {
              USDC: [{ rail: 'balance' }],
              USD: [{ rail: 'instrument', instrumentId: 'optional' }],
            },
            subscription: {
              USDC: [{ rail: 'balance' }],
            },
          },
          currencyRails: {
            USDC: { rail: 'balance' },
            USD: { rail: 'instrument', instrumentId: 'optional' },
          },
        },
        supportedCurrencies: ['USDC', 'USD'],
        supportedIntents: ['charge', 'subscription'],
      },
    ],
    ...overrides,
  };
}

/** Register a `/config` handler. Must be called before constructing `inflow()` (the factory primes config eagerly). */
function mockConfig(body: MppConfigResponse = config()): void {
  server.use(http.get(`${BASE}/v1/mpp/config`, () => HttpResponse.json(body)));
}

/** A success redeem handler that records the request body + headers it received. */
function mockRedeemSuccess(
  method = 'inflow',
  extensions: Record<string, unknown> = {},
): { body(): unknown; idempotencyKey(): string | null } {
  let captured: unknown;
  let key: string | null = null;
  server.use(
    http.post(`${BASE}/v1/mpp/redeem`, async ({ request }) => {
      captured = await request.json();
      key = request.headers.get('Idempotency-Key');
      return HttpResponse.json({
        receipt: {
          challengeId: 'c1',
          method,
          reference: 'ref-123',
          settlement: { amount: '10', currency: 'USDC' },
          status: 'success',
          timestamp: '2026-05-31T00:00:00Z',
          ...extensions,
        },
        receiptHeader: 'ignored-by-mppx',
      });
    }),
  );
  return { body: () => captured, idempotencyKey: () => key };
}

// Pin `realm` so a challenge minted via `mppx.challenge...` (no Request context) and one re-derived at submission (from
// the request URL) share the realm that the HMAC binds — otherwise the credential fails Challenge.verify on realm.
const REALM = 'app.test';
function makeMppx(method = inflow({ apiKey: 'sk_test', baseUrl: BASE })) {
  return { method, mppx: Mppx.create({ methods: [method], secretKey: SECRET, realm: REALM }) };
}

function makeTempoMppx(
  method = tempo({ apiKey: 'sk_test', baseUrl: BASE, currency: TEMPO_ASSET, recipient: TEMPO_RECIPIENT }),
) {
  return { method, mppx: Mppx.create({ methods: [method], secretKey: SECRET, realm: REALM }) };
}

const SUB = {
  amount: '9.99',
  currency: 'USDC',
  periodUnit: 'month',
  periodCount: 1,
  subscriptionExpires: '2027-01-01T00:00:00Z',
} as const;

function makeSubMppx(method = inflow.subscription({ apiKey: 'sk_test', baseUrl: BASE })) {
  return { method, mppx: Mppx.create({ methods: [method], secretKey: SECRET, realm: REALM }) };
}

/** Decode the `inflow` challenge request object out of a 402 response's WWW-Authenticate header. */
function decodeChallengeRequest(response: Response): Record<string, unknown> {
  const header = response.headers.get('WWW-Authenticate');
  if (header === null) throw new Error('no WWW-Authenticate header');
  const challenge = parseChallengeHeader(header);
  return decode(challenge.request);
}

describe('native issuance: currency → rail in the minted 402', () => {
  it('mints a single balance-rail challenge for a crypto currency (USDC)', async () => {
    mockConfig();
    const { mppx } = makeMppx();
    const r = await mppx.charge({ amount: '0.01', currency: 'USDC' })(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const request = decodeChallengeRequest(r.challenge);
    expect(request).toMatchObject({
      amount: '0.01',
      currency: 'USDC',
      recipient: SELLER,
      methodDetails: { rail: 'balance' },
    });
  });

  it('mints an instrument-rail challenge for a fiat currency (USD), carrying a supplied instrumentId', async () => {
    mockConfig();
    const { mppx } = makeMppx();
    const r = await mppx.charge({
      amount: '5',
      currency: 'USD',
      recipient: UUID,
      methodDetails: { instrumentId: INSTRUMENT },
    })(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const request = decodeChallengeRequest(r.challenge);
    expect(request['methodDetails']).toEqual({ rail: 'instrument', instrumentId: INSTRUMENT });
  });

  it('exposes request-aware canOffer gating for composed InFlow offers', async () => {
    mockConfig();
    const canOffer = vi.fn<NonNullable<InflowSellerParameters['canOffer']>>(
      ({ input, request }) => input.headers.get('x-payment-currency') === request.currency,
    );
    const { method, mppx } = makeMppx(inflow({ apiKey: 'sk_test', baseUrl: BASE, canOffer }));
    const handler = mppx.compose([method, { amount: '1', currency: 'USDC' }]);

    await expect(
      handler(new Request('https://app.test/r', { headers: { 'x-payment-currency': 'USD' } })),
    ).rejects.toThrow('No payment offers are available for this request');

    const response = await handler(new Request('https://app.test/r', { headers: { 'x-payment-currency': 'USDC' } }));
    expect(response.status).toBe(402);
    expect(canOffer).toHaveBeenCalledTimes(2);
    expect(canOffer.mock.calls[1]?.[0].request.currency).toBe('USDC');
  });

  it('forwards canOffer on direct methods and gates composed Tempo offers', async () => {
    mockConfig();
    const inflowCanOffer = vi.fn<NonNullable<InflowSellerParameters['canOffer']>>(() => true);
    expect(inflow({ apiKey: 'sk_test', baseUrl: BASE, canOffer: inflowCanOffer }).canOffer).toBe(inflowCanOffer);

    const tempoCanOffer = vi.fn<NonNullable<TempoSellerParameters['canOffer']>>(
      ({ input }) => input.headers.get('x-enable-tempo') === 'yes',
    );
    const { method, mppx } = makeTempoMppx(
      tempo({
        apiKey: 'sk_test',
        baseUrl: BASE,
        canOffer: tempoCanOffer,
        currency: TEMPO_ASSET,
        recipient: TEMPO_RECIPIENT,
      }),
    );
    expect(method.canOffer).toBe(tempoCanOffer);
    const handler = mppx.compose([method, { amount: '100' }]);

    await expect(handler(new Request('https://app.test/r'))).rejects.toThrow(
      'No payment offers are available for this request',
    );
    const response = await handler(new Request('https://app.test/r', { headers: { 'x-enable-tempo': 'yes' } }));
    expect(response.status).toBe(402);
    expect(tempoCanOffer).toHaveBeenCalledTimes(2);
  });

  it('keeps composed offers eligible when canOffer is omitted', async () => {
    mockConfig();
    const { method, mppx } = makeMppx();
    expect(method.canOffer).toBeUndefined();

    const response = await mppx.compose([method, { amount: '1', currency: 'USDC' }])(new Request('https://app.test/r'));

    expect(response.status).toBe(402);
  });

  it('emits no inflow challenge for an unsupported currency (JPY)', async () => {
    mockConfig();
    const { mppx } = makeMppx();
    await expect(
      mppx.charge({ amount: '1', currency: 'JPY', recipient: UUID })(new Request('https://app.test/r')),
    ).rejects.toBeInstanceOf(MppUnsupportedCurrencyError);
  });

  it('requires an explicit rail when a currency offers multiple charge rails', async () => {
    mockConfig(
      config({
        supportedMethods: [
          {
            id: 'inflow',
            label: 'InFlow',
            methodDetails: {
              intentCurrencyRails: { charge: { USD: [{ rail: 'balance' }, { rail: 'instrument' }] } },
              currencyRails: {},
            },
            supportedCurrencies: ['USD'],
            supportedIntents: ['charge'],
          },
        ],
      }),
    );
    const { mppx } = makeMppx();

    await expect(
      mppx.charge({ amount: '1', currency: 'USD', recipient: UUID })(new Request('https://app.test/r')),
    ).rejects.toBeInstanceOf(MppAmbiguousRailError);
  });

  it('uses an explicitly selected advertised rail when a currency offers multiple charge rails', async () => {
    mockConfig(
      config({
        supportedMethods: [
          {
            id: 'inflow',
            label: 'InFlow',
            methodDetails: {
              intentCurrencyRails: { charge: { USD: [{ rail: 'balance' }, { rail: 'instrument' }] } },
              currencyRails: {},
            },
            supportedCurrencies: ['USD'],
            supportedIntents: ['charge'],
          },
        ],
      }),
    );
    const { mppx } = makeMppx();
    const result = await mppx.charge({
      amount: '1',
      currency: 'USD',
      recipient: UUID,
      methodDetails: { rail: 'balance' },
    })(new Request('https://app.test/r'));

    expect(result.status).toBe(402);
    if (result.status !== 402) throw new Error('expected 402');
    expect(decodeChallengeRequest(result.challenge)['methodDetails']).toEqual({ rail: 'balance' });
  });

  it('rejects an explicitly selected rail not advertised for the currency and intent', async () => {
    mockConfig();
    const { mppx } = makeMppx();

    await expect(
      mppx.charge({
        amount: '1',
        currency: 'USDC',
        recipient: UUID,
        methodDetails: { rail: 'instrument' },
      })(new Request('https://app.test/r')),
    ).rejects.toBeInstanceOf(MppUnsupportedRailError);
  });

  it('requires an instrument identifier when the selected capability requires one', async () => {
    mockConfig(
      config({
        supportedMethods: [
          {
            id: 'inflow',
            label: 'InFlow',
            methodDetails: {
              intentCurrencyRails: { charge: { USD: [{ rail: 'instrument', instrumentId: 'required' }] } },
              currencyRails: {},
            },
            supportedCurrencies: ['USD'],
            supportedIntents: ['charge'],
          },
        ],
      }),
    );
    const { mppx } = makeMppx();

    await expect(
      mppx.charge({ amount: '1', currency: 'USD', recipient: UUID })(new Request('https://app.test/r')),
    ).rejects.toBeInstanceOf(MppInstrumentRequiredError);
  });

  it('does not fall back to the charge compatibility map when the intent matrix omits a subscription currency', async () => {
    mockConfig();
    const { mppx } = makeSubMppx();

    await expect(
      mppx.compose(['inflow/subscription', { ...SUB, currency: 'USD' }])(new Request('https://app.test/r')),
    ).rejects.toBeInstanceOf(MppUnsupportedCurrencyError);
  });

  it('honours the pinned currency default and all client options', async () => {
    mockConfig();
    const method = inflow({
      apiKey: 'sk_test',
      baseUrl: BASE,
      environment: 'sandbox',
      currency: 'USDC',
      timeoutMs: 5_000,
      fetch: globalThis.fetch,
    });
    const mppx = Mppx.create({ methods: [method], secretKey: SECRET, realm: REALM });
    const r = await mppx.charge({ amount: '7' })(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    expect(decodeChallengeRequest(r.challenge)).toMatchObject({
      amount: '7',
      currency: 'USDC',
      recipient: SELLER,
      methodDetails: { rail: 'balance' },
    });
  });

  it('mints a Tempo challenge with fee-payer disabled by default', async () => {
    mockConfig();
    const { mppx } = makeTempoMppx();
    const r = await mppx.charge({ amount: '100' })(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const request = decodeChallengeRequest(r.challenge);
    expect(request).toMatchObject({
      amount: '100',
      currency: TEMPO_ASSET,
      recipient: TEMPO_RECIPIENT,
      methodDetails: { feePayer: false, supportedModes: ['pull'] },
    });
  });

  it('mints a Tempo fee-payer challenge from method defaults', async () => {
    mockConfig();
    const { mppx } = makeTempoMppx(
      tempo({
        apiKey: 'sk_test',
        baseUrl: BASE,
        currency: TEMPO_ASSET,
        methodDetails: { feePayer: true },
        recipient: TEMPO_RECIPIENT,
      }),
    );

    const r = await mppx.charge({ amount: '100' })(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const request = decodeChallengeRequest(r.challenge);
    expect(request['methodDetails']).toMatchObject({ feePayer: true, supportedModes: ['pull'] });
  });

  it('mints a Tempo fee-payer challenge from per-charge method details', async () => {
    mockConfig();
    const { mppx } = makeTempoMppx();

    const r = await mppx.charge({ amount: '100', methodDetails: { feePayer: true } })(
      new Request('https://app.test/r'),
    );
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const request = decodeChallengeRequest(r.challenge);
    expect(request['methodDetails']).toMatchObject({ feePayer: true, supportedModes: ['pull'] });
  });

  it('re-derives the same request across two mints (pure request hook)', async () => {
    mockConfig();
    const { mppx } = makeMppx();
    const charge = mppx.charge({ amount: '2.5', currency: 'USDC', recipient: UUID });
    const r1 = await charge(new Request('https://app.test/r'));
    const r2 = await charge(new Request('https://app.test/r'));
    if (r1.status !== 402 || r2.status !== 402) throw new Error('expected 402');
    expect(decodeChallengeRequest(r1.challenge)).toEqual(decodeChallengeRequest(r2.challenge));
  });
});

describe('stableBinding', () => {
  it('binds rail and instrumentId alongside the core fields', () => {
    mockConfig();
    const { method } = makeMppx();
    const binding = method.stableBinding!({
      amount: '5',
      currency: 'USD',
      recipient: UUID,
      methodDetails: { rail: 'instrument', instrumentId: INSTRUMENT },
    });
    expect(binding).toEqual({
      amount: '5',
      currency: 'USD',
      recipient: UUID,
      rail: 'instrument',
      instrumentId: INSTRUMENT,
    });
  });

  it('produces a different binding for balance vs instrument', () => {
    mockConfig();
    const { method } = makeMppx();
    const balance = method.stableBinding!({
      amount: '5',
      currency: 'USDC',
      recipient: UUID,
      methodDetails: { rail: 'balance' },
    });
    const instrument = method.stableBinding!({
      amount: '5',
      currency: 'USD',
      recipient: UUID,
      methodDetails: { rail: 'instrument' },
    });
    expect(balance['rail']).not.toBe(instrument['rail']);
  });

  it('defaults the bound rail to balance when methodDetails is absent', () => {
    mockConfig();
    const { method } = makeMppx();
    const binding = method.stableBinding!({ amount: '1', currency: 'USDC', recipient: UUID });
    expect(binding['rail']).toBe('balance');
  });

  it('binds Tempo chain, memo, split, and metadata fields', () => {
    mockConfig();
    const { method } = makeTempoMppx();
    const binding = method.stableBinding!({
      amount: '100',
      currency: TEMPO_ASSET,
      description: 'invoice',
      externalId: 'inv-1',
      recipient: TEMPO_RECIPIENT,
      methodDetails: {
        chainId: 555555555,
        feePayer: false,
        memo: TEMPO_MEMO,
        splits: [{ amount: '10', memo: TEMPO_MEMO, recipient: TEMPO_SPLIT_RECIPIENT }],
        supportedModes: ['pull'],
      },
    });
    expect(binding).toEqual({
      amount: '100',
      chainId: 555555555,
      currency: TEMPO_ASSET,
      description: 'invoice',
      externalId: 'inv-1',
      feePayer: false,
      memo: TEMPO_MEMO,
      recipient: TEMPO_RECIPIENT,
      splits: [{ amount: '10', memo: TEMPO_MEMO, recipient: TEMPO_SPLIT_RECIPIENT }],
      supportedModes: ['pull'],
    });
  });
});

describe('verify → /v1/mpp/redeem', () => {
  it('reflects a receipt and attaches the Payment-Receipt header; forwards the transactionId idempotency key', async () => {
    mockConfig();
    const redeem = mockRedeemSuccess();
    const { mppx } = makeMppx();

    const challenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    const authorization = Credential.serialize({
      challenge,
      payload: { transactionId: 'tx-1', type: 'balance', approvalId: 'appr-1' },
      source: 'did:inflow:payer',
    });

    const r = await mppx.charge({ amount: '10', currency: 'USDC', recipient: UUID })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('expected 200');

    const settled = r.withReceipt(new Response('ok'));
    const receipt = Receipt.fromResponse(settled);
    expect(receipt.method).toBe('inflow');
    expect(receipt.reference).toBe('ref-123');
    expect(receipt.status).toBe('success');

    const receiptHeader = settled.headers.get('Payment-Receipt');
    if (receiptHeader === null) throw new Error('expected Payment-Receipt header');
    expect(decodeReceipt(receiptHeader)).toEqual({
      challengeId: 'c1',
      method: 'inflow',
      reference: 'ref-123',
      settlement: { amount: '10', currency: 'USDC' },
      status: 'success',
      timestamp: '2026-05-31T00:00:00Z',
    });

    // The credential's server-minted transactionId round-trips to redeem and is used as the idempotency key.
    expect(redeem.idempotencyKey()).toBe('tx-1');
    const body = redeem.body() as { credential: { payload: Record<string, unknown> } };
    expect(body.credential.payload['transactionId']).toBe('tx-1');
  });

  it('keeps method-specific receipt extension fields when mapping to mppx', async () => {
    mockConfig();
    mockRedeemSuccess('inflow', {
      chainId: 1001,
      providerReceiptId: 'prov-1',
    });
    const { mppx } = makeMppx();

    const challenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    const authorization = Credential.serialize({
      challenge,
      payload: { transactionId: 'tx-ext', type: 'balance', approvalId: 'appr-ext' },
      source: 'did:inflow:payer',
    });

    const r = await mppx.charge({ amount: '10', currency: 'USDC', recipient: UUID })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('expected 200');

    const settled = r.withReceipt(new Response('ok'));
    const receiptHeader = settled.headers.get('Payment-Receipt');
    if (receiptHeader === null) throw new Error('expected Payment-Receipt header');
    expect(decodeReceipt(receiptHeader)).toEqual({
      challengeId: 'c1',
      method: 'inflow',
      reference: 'ref-123',
      settlement: { amount: '10', currency: 'USDC' },
      status: 'success',
      timestamp: '2026-05-31T00:00:00Z',
      chainId: 1001,
      providerReceiptId: 'prov-1',
    });
  });

  it('drops prototype-mutating receipt extension keys before composing the receipt', async () => {
    mockConfig();
    let deeplyNested: Record<string, unknown> = { safe: 'bottom' };
    for (let depth = 0; depth < 18; depth += 1) deeplyNested = { nested: deeplyNested };
    const unsafeExtensions = {
      ...(JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":"spoofed","prototype":"spoofed","providerReceiptId":"prov-safe","nested":{"__proto__":{"polluted":true},"safe":"kept"},"items":[{"__proto__":{"polluted":true},"safe":"kept"},1,true,null]}',
      ) as Record<string, unknown>),
      deeplyNested,
      overBudget: Array.from({ length: 257 }, () => 'value'),
      wide: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`key-${index}`, 'value'])),
    };
    mockRedeemSuccess('inflow', {
      ...unsafeExtensions,
      nestedReceiptId: 'nested-safe',
    });
    const { mppx } = makeMppx();

    const challenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    const authorization = Credential.serialize({
      challenge,
      payload: { transactionId: 'tx-safe-ext', type: 'balance' },
      source: 'did:inflow:payer',
    });
    const r = await mppx.charge({ amount: '10', currency: 'USDC', recipient: UUID })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('expected 200');

    const receiptHeader = r.withReceipt(new Response('ok')).headers.get('Payment-Receipt');
    if (receiptHeader === null) throw new Error('expected Payment-Receipt header');
    const receipt = decodeReceipt(receiptHeader);
    expect(receipt).toMatchObject({
      providerReceiptId: 'prov-safe',
      nestedReceiptId: 'nested-safe',
      nested: { safe: 'kept' },
      items: [{ safe: 'kept' }, 1, true, null],
    });
    expect(Object.hasOwn(receipt, '__proto__')).toBe(false);
    expect(Object.hasOwn(receipt, 'constructor')).toBe(false);
    expect(Object.hasOwn(receipt, 'prototype')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('"__proto__"');
    expect(JSON.stringify(receipt)).not.toContain('deeplyNested');
    expect(JSON.stringify(receipt)).not.toContain('overBudget');
    expect(JSON.stringify(receipt)).not.toContain('"wide"');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('forwards the transactionId idempotency key for Tempo redeem', async () => {
    mockConfig();
    const redeem = mockRedeemSuccess('tempo');
    const { mppx } = makeTempoMppx();

    const challenge = await mppx.challenge.tempo.charge({ amount: '100' });
    const authorization = Credential.serialize({
      challenge,
      payload: { transactionId: 'tx-tempo', type: 'transaction', signature: '0x76deadbeef' },
      source: 'did:pkh:eip155:555555555:0x4444444444444444444444444444444444444444',
    });

    const r = await mppx.charge({ amount: '100' })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('expected 200');

    expect(redeem.idempotencyKey()).toBe('tx-tempo');
    const body = redeem.body() as { credential: { payload: Record<string, unknown> } };
    expect(body.credential.payload['transactionId']).toBe('tx-tempo');
  });

  it('throws MppRedeemProblemError → framework emits 402 + the RFC 9457 problem body', async () => {
    mockConfig();
    const problem = {
      type: 'https://paymentauth.org/problems/payment-insufficient',
      title: 'Payment Insufficient',
      status: 402,
      detail: 'Balance too low.',
    };
    server.use(http.post(`${BASE}/v1/mpp/redeem`, () => HttpResponse.json({ problem })));
    const { mppx } = makeMppx();

    const challenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    const authorization = Credential.serialize({
      challenge,
      payload: { transactionId: 'tx-2', type: 'balance' },
      source: 'did:inflow:payer',
    });

    const r = await mppx.charge({ amount: '10', currency: 'USDC', recipient: UUID })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    const body = (await r.challenge.json()) as { type: string; detail: string; status: number };
    expect(body.type).toBe('https://paymentauth.org/problems/payment-insufficient');
    expect(body.detail).toBe('Balance too low.');
    expect(body.status).toBe(402);
  });

  it('surfaces the redeem problem as a typed MppRedeemProblemError from verify directly', async () => {
    mockConfig();
    const problem = {
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: 'nope',
    };
    server.use(http.post(`${BASE}/v1/mpp/redeem`, () => HttpResponse.json({ problem })));
    const { method, mppx } = makeMppx();
    const challenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });

    await expect(
      method.verify({
        credential: { challenge, payload: { transactionId: 'tx-3', type: 'balance' }, source: 'did:inflow:p' },
        request: challenge.request,
      } as unknown as VerifyArg),
    ).rejects.toBeInstanceOf(MppRedeemProblemError);
  });

  it('never forwards a top-level bodyDigest, even when the challenge carries a digest', async () => {
    mockConfig();
    let captured: { bodyDigest?: string; credential: { challenge: Record<string, unknown> } } | undefined;
    server.use(
      http.post(`${BASE}/v1/mpp/redeem`, async ({ request }) => {
        captured = (await request.json()) as {
          bodyDigest?: string;
          credential: { challenge: Record<string, unknown> };
        };
        return HttpResponse.json({
          receipt: {
            challengeId: 'c1',
            method: 'inflow',
            reference: 'ref-9',
            settlement: { amount: '10', currency: 'USDC' },
            status: 'success',
            timestamp: '2026-05-31T00:00:00Z',
          },
        });
      }),
    );
    const { method, mppx } = makeMppx();
    const minted = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    // Also exercise the optional expires/description/digest spreads in the wire-credential mapping.
    const challenge = {
      ...minted,
      digest: 'sha-256=Zm9vYmFy',
      expires: '2026-05-31T12:00:00Z',
      description: 'pay',
      opaque: 'eyJvcmRlcklkIjoib3JkZXItMTIzIn0',
    };

    await method.verify({
      credential: { challenge, payload: { transactionId: 'tx-4', type: 'balance' }, source: 'did:inflow:p' },
      request: challenge.request,
    } as unknown as VerifyArg);
    const body = captured!;
    // The SDK does not compute or forward a top-level body digest. The challenge's own `digest` is echoed verbatim
    // inside the credential (wire passthrough), but there is no separate top-level `bodyDigest`.
    expect(body.bodyDigest).toBeUndefined();
    expect(body.credential.challenge['expires']).toBe('2026-05-31T12:00:00Z');
    expect(body.credential.challenge['description']).toBe('pay');
    expect(body.credential.challenge['digest']).toBe('sha-256=Zm9vYmFy');
    expect(body.credential.challenge['opaque']).toBe('eyJvcmRlcklkIjoib3JkZXItMTIzIn0');
  });

  it('throws a verification-failed fallback when redeem returns neither receipt nor problem', async () => {
    mockConfig();
    server.use(http.post(`${BASE}/v1/mpp/redeem`, () => HttpResponse.json({})));
    const { method, mppx } = makeMppx();
    const minted = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    // A bare challenge (no expires/description/digest) and a credential with no `source` exercise the untaken sides of
    // the optional wire-credential spreads.
    const challenge = {
      id: 'c1',
      realm: REALM,
      method: 'inflow' as const,
      intent: 'charge' as const,
      request: minted.request,
    };

    await expect(
      method.verify({
        credential: { challenge, payload: { transactionId: 'tx-5' } },
        request: challenge.request,
      } as unknown as VerifyArg),
    ).rejects.toMatchObject({ problem: { type: 'https://paymentauth.org/problems/verification-failed' } });
  });
});

describe('inflow subscription: issuance, binding, verify', () => {
  it('mints a balance-rail subscription challenge carrying the recurring terms', async () => {
    mockConfig();
    const { mppx } = makeSubMppx();
    const r = await mppx.compose(['inflow/subscription', SUB])(new Request('https://app.test/r'));
    expect(r.status).toBe(402);
    if (r.status !== 402) throw new Error('expected 402');
    expect(decodeChallengeRequest(r.challenge)).toMatchObject({
      amount: '9.99',
      currency: 'USDC',
      recipient: SELLER,
      methodDetails: { rail: 'balance' },
      periodUnit: 'month',
      periodCount: 1,
      subscriptionExpires: '2027-01-01T00:00:00Z',
    });
  });

  it('binds the recurring terms alongside the core fields', () => {
    mockConfig();
    const { method } = makeSubMppx();
    const binding = method.stableBinding!({
      amount: '9.99',
      currency: 'USDC',
      recipient: UUID,
      methodDetails: { rail: 'balance' },
      periodUnit: 'month',
      periodCount: 1,
      subscriptionExpires: '2027-01-01T00:00:00Z',
      externalId: 'plan_pro',
    });
    expect(binding).toEqual({
      amount: '9.99',
      currency: 'USDC',
      recipient: UUID,
      rail: 'balance',
      periodUnit: 'month',
      periodCount: 1,
      subscriptionExpires: '2027-01-01T00:00:00Z',
      externalId: 'plan_pro',
    });
  });

  it('verify reflects the receipt and preserves the server-issued subscriptionId', async () => {
    mockConfig();
    let idempotencyKey: string | null = null;
    server.use(
      http.post(`${BASE}/v1/mpp/redeem`, ({ request }) => {
        idempotencyKey = request.headers.get('idempotency-key');
        return HttpResponse.json({
          receipt: {
            challengeId: 'c1',
            method: 'inflow',
            reference: 'ref-sub',
            externalId: 'seller-plan-42',
            settlement: { amount: '9.99', currency: 'USDC' },
            status: 'success',
            timestamp: '2027-01-01T00:00:00Z',
            subscriptionId: 'sub_abc',
          },
        });
      }),
    );
    const { mppx } = makeSubMppx();
    const challenge = await mppx.challenge.inflow.subscription(SUB);
    const authorization = Credential.serialize({
      challenge,
      payload: { authorizationId: 'auth-sub', transactionId: 'tx-sub', type: 'balance', approvalId: 'appr-1' },
      source: 'did:inflow:payer',
    });
    const r = await mppx.compose(['inflow/subscription', SUB])(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) throw new Error('expected 200');
    const settled = r.withReceipt(new Response('ok'));
    const header = settled.headers.get('Payment-Receipt');
    if (header === null) throw new Error('expected Payment-Receipt header');
    expect(decodeReceipt(header)).toMatchObject({ externalId: 'seller-plan-42', subscriptionId: 'sub_abc' });
    expect(idempotencyKey).toBe('auth-sub');
  });
});

describe('stableBinding rejection across rails (framework)', () => {
  it('rejects a balance-rail credential replayed against an instrument route with no redeem call', async () => {
    mockConfig();
    let redeemHits = 0;
    server.use(
      http.post(`${BASE}/v1/mpp/redeem`, () => {
        redeemHits += 1;
        return HttpResponse.json({ problem: { type: 't', title: 't', status: 402, detail: 'should not be reached' } });
      }),
    );
    const { mppx } = makeMppx();

    // Mint a balance (USDC) challenge with a valid HMAC, then submit it against an instrument (USD) route.
    const balanceChallenge = await mppx.challenge.inflow.charge({ amount: '10', currency: 'USDC', recipient: UUID });
    const authorization = Credential.serialize({
      challenge: balanceChallenge,
      payload: { transactionId: 'tx-x', type: 'balance' },
      source: 'did:inflow:p',
    });

    const r = await mppx.charge({ amount: '10', currency: 'USD', recipient: UUID })(
      new Request('https://app.test/r', { headers: { Authorization: authorization } }),
    );
    expect(r.status).toBe(402);
    expect(redeemHits).toBe(0);
  });
});

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';

import { createInflowFacilitator, createUnauthenticatedInflowFacilitator } from '../../src/facilitator.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface CallCounts {
  supported: number;
  verify: number;
  settle: number;
}

function paymentIdFromBody(body: unknown): string | undefined {
  const request = body as {
    paymentPayload?: { extensions?: Record<string, { info?: { id?: unknown } }> };
  };
  const id = request.paymentPayload?.extensions?.['payment-identifier']?.info?.id;
  return typeof id === 'string' ? id : undefined;
}

function installDefaultHandlers(counts: CallCounts = { supported: 0, verify: 0, settle: 0 }): CallCounts {
  server.use(
    http.get(`${PROD_BASE}/v1/x402/supported`, () => {
      counts.supported += 1;
      return HttpResponse.json(SAMPLE_SUPPORTED);
    }),
    http.post(`${PROD_BASE}/v1/x402/verify`, () => {
      counts.verify += 1;
      return HttpResponse.json({ isValid: true });
    }),
    http.post(`${PROD_BASE}/v1/x402/settle`, () => {
      counts.settle += 1;
      return HttpResponse.json({
        success: true,
        payer: '0xpayer',
        transaction: '0xtxhash',
        network: 'eip155:8453',
      });
    }),
  );
  return counts;
}

describe('createInflowFacilitator', () => {
  let counts: CallCounts;

  beforeEach(() => {
    counts = installDefaultHandlers();
  });

  it('returns a FacilitatorClient with only verify / settle / getSupported', () => {
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    expect(typeof fac.verify).toBe('function');
    expect(typeof fac.settle).toBe('function');
    expect(typeof fac.getSupported).toBe('function');
    // The slimmed shape has no `name` field, no config/refresh/signer
    // methods — those moved to InflowSellerClient.
    const facAsRecord = fac as unknown as Record<string, unknown>;
    expect(facAsRecord['name']).toBeUndefined();
    expect(facAsRecord['config']).toBeUndefined();
    expect(facAsRecord['refreshConfig']).toBeUndefined();
    expect(facAsRecord['refreshSupported']).toBeUndefined();
    expect(facAsRecord['getSignerAddresses']).toBeUndefined();
  });

  it('is synchronous — does not prime any cache at construction', () => {
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    expect(counts.supported).toBe(0);
    expect(fac).not.toBeInstanceOf(Promise);
  });

  it('attaches the API key on outbound getSupported', async () => {
    let captured: string | null = null;
    server.use(
      http.get(`${PROD_BASE}/v1/x402/supported`, ({ request }) => {
        captured = request.headers.get('x-api-key');
        return HttpResponse.json(SAMPLE_SUPPORTED);
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    await fac.getSupported();
    expect(captured).toBe('sk_test');
  });

  it('caches getSupported responses within the TTL', async () => {
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const a = await fac.getSupported();
    const b = await fac.getSupported();
    expect(a).toBe(b);
    expect(counts.supported).toBe(1);
  });

  it('shares the in-flight getSupported promise across concurrent callers', async () => {
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const [a, b, c] = await Promise.all([fac.getSupported(), fac.getSupported(), fac.getSupported()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counts.supported).toBe(1);
  });

  it('verify posts x402Version:2 + payload + requirements to /v1/x402/verify', async () => {
    let captured: unknown;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: 'balance' as const,
        network: 'inflow:1' as const,
        asset: 'USDC',
        amount: '10000000000000000',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
    };
    const result = await fac.verify(payload, payload.accepted);
    expect(result.isValid).toBe(true);
    expect(captured).toMatchObject({
      x402Version: 2,
      paymentRequirements: payload.accepted,
    });
  });

  it('settle posts to /v1/x402/settle and decodes the response', async () => {
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const result = await fac.settle(
      {
        x402Version: 2,
        accepted: {
          scheme: 'balance',
          network: 'inflow:1',
          asset: 'USDC',
          amount: '1',
          payTo: SAMPLE_CONFIG.sellerId,
          maxTimeoutSeconds: 300,
          extra: {},
        },
        payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
      },
      {
        scheme: 'balance',
        network: 'inflow:1',
        asset: 'USDC',
        amount: '1',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: {},
      },
    );
    expect(result.success).toBe(true);
    expect(result.network).toBe('eip155:8453');
  });

  it('retries a pending settlement with the same payment identifier', async () => {
    const identifiers: string[] = [];
    let attempts = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/settle`, async ({ request }) => {
        attempts += 1;
        const id = paymentIdFromBody(await request.json());
        if (id !== undefined) identifiers.push(id);
        if (attempts === 1) {
          return HttpResponse.json(
            { success: false, errorReason: 'idempotency_pending' },
            { status: 409, headers: { 'Retry-After': '0' } },
          );
        }
        return HttpResponse.json({ success: true, transaction: '0xtxhash', network: 'eip155:8453' });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const accepted = {
      scheme: 'exact' as const,
      network: 'eip155:8453' as const,
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xPayTo',
      maxTimeoutSeconds: 300,
      extra: {},
    };

    const result = await fac.settle({ x402Version: 2, accepted, payload: { signature: '0xsigned' } }, accepted);

    expect(result.success).toBe(true);
    expect(identifiers).toHaveLength(2);
    expect(identifiers[1]).toBe(identifiers[0]);
  });

  it('does not retry a payment identifier conflict', async () => {
    let attempts = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/settle`, () => {
        attempts += 1;
        return HttpResponse.json({ success: false, errorReason: 'idempotency_conflict' }, { status: 409 });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const accepted = {
      scheme: 'exact' as const,
      network: 'eip155:8453' as const,
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xPayTo',
      maxTimeoutSeconds: 300,
      extra: {},
    };

    await expect(
      fac.settle({ x402Version: 2, accepted, payload: { signature: '0xsigned' } }, accepted),
    ).rejects.toMatchObject({ httpStatus: 409, body: { errorReason: 'idempotency_conflict' } });
    expect(attempts).toBe(1);
  });

  it('stops retrying a pending settlement at the bounded attempt limit', async () => {
    let attempts = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/settle`, () => {
        attempts += 1;
        return HttpResponse.json(
          { success: false, errorReason: 'idempotency_pending' },
          { status: 409, headers: { 'Retry-After': '0' } },
        );
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const accepted = {
      scheme: 'exact' as const,
      network: 'eip155:8453' as const,
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xPayTo',
      maxTimeoutSeconds: 300,
      extra: {},
    };

    await expect(
      fac.settle({ x402Version: 2, accepted, payload: { signature: '0xsigned' } }, accepted),
    ).rejects.toMatchObject({ httpStatus: 409, body: { errorReason: 'idempotency_pending' } });
    expect(attempts).toBe(5);
  });

  it('verify auto-embeds a payment-identifier extension entry when absent', async () => {
    let captured: { paymentPayload?: { extensions?: Record<string, unknown> } } | undefined;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: 'balance' as const,
        network: 'inflow:1' as const,
        asset: 'USDC',
        amount: '1',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
    };
    await fac.verify(payload, payload.accepted);
    const entry = captured?.paymentPayload?.extensions?.['payment-identifier'] as
      { info?: { id?: string; required?: boolean }; schema?: unknown } | undefined;
    expect(entry?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/u);
    expect(entry?.info?.required).toBe(false);
    expect(entry?.schema).toEqual(PAYMENT_IDENTIFIER.buildDeclaration({}).schema);
  });

  it('verify preserves a caller-supplied payment-identifier entry', async () => {
    let captured: { paymentPayload?: { extensions?: Record<string, unknown> } } | undefined;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const supplied = 'pay_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const suppliedEntry = PAYMENT_IDENTIFIER.buildPayloadEntry(PAYMENT_IDENTIFIER.buildDeclaration({}), {
      providedPaymentId: supplied,
    });
    if (suppliedEntry === null) throw new Error('Invalid payment identifier test fixture');
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: 'balance' as const,
        network: 'inflow:1' as const,
        asset: 'USDC',
        amount: '1',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions: { 'payment-identifier': suppliedEntry },
    };
    await fac.verify(payload, payload.accepted);
    expect(captured?.paymentPayload?.extensions?.['payment-identifier']).toEqual(suppliedEntry);
  });

  it('verify replaces a malformed entry without mutating the caller payload', async () => {
    let captured: { paymentPayload?: { extensions?: Record<string, unknown> } } | undefined;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const extensions = {
      'payment-identifier': { info: { id: 'too-short', required: false } },
      receipt: { enabled: true },
    };
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: 'balance' as const,
        network: 'inflow:1' as const,
        asset: 'USDC',
        amount: '1',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
      extensions,
    };

    await fac.verify(payload, payload.accepted);

    expect(extensions).toEqual({
      'payment-identifier': { info: { id: 'too-short', required: false } },
      receipt: { enabled: true },
    });
    expect(captured?.paymentPayload?.extensions?.['receipt']).toEqual({ enabled: true });
    const entry = captured?.paymentPayload?.extensions?.['payment-identifier'] as
      { info?: { id?: string; required?: boolean }; schema?: unknown } | undefined;
    expect(entry?.info?.id).toMatch(/^pay_[a-f0-9]{32}$/u);
    expect(entry?.info?.required).toBe(false);
    expect(entry?.schema).toEqual(PAYMENT_IDENTIFIER.buildDeclaration({}).schema);
  });

  it.each([
    ['an EVM signature', { signature: '0xsigned-payment', authorization: { nonce: '0x01' } }],
    ['a Solana transaction', { transaction: 'AQABAgMEBQYH' }],
    ['an InFlow transaction', { transactionId: '00000000-0000-0000-0000-000000000abc' }],
  ])('derives one identifier across verify and repeated settlement from %s', async (_label, signedPayload) => {
    const seen: string[] = [];
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        const id = paymentIdFromBody(await request.json());
        if (id !== undefined) seen.push(id);
        return HttpResponse.json({ isValid: true });
      }),
      http.post(`${PROD_BASE}/v1/x402/settle`, async ({ request }) => {
        const id = paymentIdFromBody(await request.json());
        if (id !== undefined) seen.push(id);
        return HttpResponse.json({
          success: true,
          payer: '0xpayer',
          transaction: '0xtxhash',
          network: 'eip155:8453',
        });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: 'exact' as const,
        network: 'eip155:8453' as const,
        asset: '0xUSDC',
        amount: '10000',
        payTo: '0xPayTo',
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: signedPayload,
    };

    await fac.verify(payload, payload.accepted);
    await fac.settle({ ...payload, payload: { ...signedPayload } }, payload.accepted);
    await fac.settle({ ...payload, payload: { ...signedPayload } }, payload.accepted);

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatch(/^pay_[a-f0-9]{32}$/u);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  it('derives different identifiers from different signed payments', async () => {
    const seen: string[] = [];
    server.use(
      http.post(`${PROD_BASE}/v1/x402/settle`, async ({ request }) => {
        const id = paymentIdFromBody(await request.json());
        if (id !== undefined) seen.push(id);
        return HttpResponse.json({
          success: true,
          payer: '0xpayer',
          transaction: '0xtxhash',
          network: 'eip155:8453',
        });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    const accepted = {
      scheme: 'exact' as const,
      network: 'eip155:8453' as const,
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xPayTo',
      maxTimeoutSeconds: 300,
      extra: {},
    };

    await fac.settle({ x402Version: 2, accepted, payload: { signature: '0xfirst' } }, accepted);
    await fac.settle({ x402Version: 2, accepted, payload: { signature: '0xsecond' } }, accepted);

    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('attaches the API key on outbound verify', async () => {
    let captured: string | null = null;
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, ({ request }) => {
        captured = request.headers.get('x-api-key');
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createInflowFacilitator({ environment: 'production', apiKey: 'sk_test' });
    await fac.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xUSDC',
          amount: '10000',
          payTo: '0xPayTo',
          maxTimeoutSeconds: 300,
          extra: {},
        },
        payload: { authorization: { from: '0xFrom' }, signature: '0xSig' },
      },
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0xUSDC',
        amount: '10000',
        payTo: '0xPayTo',
        maxTimeoutSeconds: 300,
        extra: {},
      },
    );
    expect(captured).toBe('sk_test');
  });
});

describe('createUnauthenticatedInflowFacilitator', () => {
  let counts: CallCounts;

  beforeEach(() => {
    counts = installDefaultHandlers();
  });

  it('returns a FacilitatorClient with verify/settle/getSupported', () => {
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    expect(typeof fac.verify).toBe('function');
    expect(typeof fac.settle).toBe('function');
    expect(typeof fac.getSupported).toBe('function');
  });

  it('is synchronous — does not prime any cache at construction', () => {
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    expect(counts.supported).toBe(0);
    expect(fac).not.toBeInstanceOf(Promise);
  });

  it('sends no X-API-KEY header on getSupported', async () => {
    let captured: string | null = 'unset';
    server.use(
      http.get(`${PROD_BASE}/v1/x402/supported`, ({ request }) => {
        captured = request.headers.get('x-api-key');
        return HttpResponse.json(SAMPLE_SUPPORTED);
      }),
    );
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    await fac.getSupported();
    expect(captured).toBeNull();
  });

  it('sends no X-API-KEY header on verify', async () => {
    let captured: string | null = 'unset';
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, ({ request }) => {
        captured = request.headers.get('x-api-key');
        return HttpResponse.json({ isValid: true });
      }),
    );
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    await fac.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xUSDC',
          amount: '10000',
          payTo: '0xPayTo',
          maxTimeoutSeconds: 300,
          extra: {},
        },
        payload: { authorization: { from: '0xFrom' }, signature: '0xSig' },
      },
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0xUSDC',
        amount: '10000',
        payTo: '0xPayTo',
        maxTimeoutSeconds: 300,
        extra: {},
      },
    );
    expect(captured).toBeNull();
  });

  it('sends no X-API-KEY header on settle', async () => {
    let captured: string | null = 'unset';
    server.use(
      http.post(`${PROD_BASE}/v1/x402/settle`, ({ request }) => {
        captured = request.headers.get('x-api-key');
        return HttpResponse.json({
          success: true,
          payer: '0xpayer',
          transaction: '0xtxhash',
          network: 'eip155:8453',
        });
      }),
    );
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    await fac.settle(
      {
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xUSDC',
          amount: '10000',
          payTo: '0xPayTo',
          maxTimeoutSeconds: 300,
          extra: {},
        },
        payload: { authorization: { from: '0xFrom' }, signature: '0xSig' },
      },
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0xUSDC',
        amount: '10000',
        payTo: '0xPayTo',
        maxTimeoutSeconds: 300,
        extra: {},
      },
    );
    expect(captured).toBeNull();
  });

  it('caches getSupported responses within the TTL', async () => {
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    const a = await fac.getSupported();
    const b = await fac.getSupported();
    expect(a).toBe(b);
    expect(counts.supported).toBe(1);
  });

  it('shares the in-flight getSupported promise across concurrent callers', async () => {
    const fac = createUnauthenticatedInflowFacilitator({ environment: 'production' });
    const [a, b, c] = await Promise.all([fac.getSupported(), fac.getSupported(), fac.getSupported()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counts.supported).toBe(1);
  });
});

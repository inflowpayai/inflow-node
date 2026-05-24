import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    expect(facAsRecord.name).toBeUndefined();
    expect(facAsRecord.config).toBeUndefined();
    expect(facAsRecord.refreshConfig).toBeUndefined();
    expect(facAsRecord.refreshSupported).toBeUndefined();
    expect(facAsRecord.getSignerAddresses).toBeUndefined();
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
    const entry = captured?.paymentPayload?.extensions?.['payment-identifier'] as { paymentId?: string } | undefined;
    expect(typeof entry?.paymentId).toBe('string');
    expect(entry?.paymentId).toMatch(/^pay_[a-f0-9]{32}$/u);
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
      extensions: { 'payment-identifier': { paymentId: supplied } },
    };
    await fac.verify(payload, payload.accepted);
    const entry = captured?.paymentPayload?.extensions?.['payment-identifier'] as { paymentId?: string } | undefined;
    expect(entry?.paymentId).toBe(supplied);
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

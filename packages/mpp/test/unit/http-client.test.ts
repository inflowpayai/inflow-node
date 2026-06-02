import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { InflowApiError } from '../../src/errors.js';
import { InflowHttpClient, MppClient } from '../../src/http-client.js';
import type { MppConfigResponse, MppRedeemResponse, MppTransactionResponse } from '../../src/types.js';

const BASE = 'https://sandbox.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client(): MppClient {
  return new MppClient({ apiKey: 'sk_test_123', environment: 'sandbox' });
}

describe('MppClient endpoints', () => {
  it('GET /v1/mpp/config returns the typed config and sends the API key', async () => {
    let seenKey: string | null = null;
    const config: MppConfigResponse = {
      sellerId: '22222222-2222-2222-2222-222222222222',
      featureFlags: { idempotencyKeyEnabled: true },
      replayPolicy: { managedBy: 'psp' },
      supportedMethods: [
        { id: 'inflow', label: 'InFlow', supportedCurrencies: ['USDC'], supportedIntents: ['charge'] },
      ],
    };
    server.use(
      http.get(`${BASE}/v1/mpp/config`, ({ request }) => {
        seenKey = request.headers.get('x-api-key');
        return HttpResponse.json(config);
      }),
    );
    await expect(client().getConfig()).resolves.toEqual(config);
    expect(seenKey).toBe('sk_test_123');
  });

  it('POST /v1/mpp/redeem forwards the Idempotency-Key header', async () => {
    let seenIdem: string | null = null;
    const response: MppRedeemResponse = {
      receipt: {
        challengeId: 'c1',
        method: 'inflow',
        reference: 'ref_1',
        status: 'success',
        timestamp: '2025-01-15T12:05:00Z',
      },
    };
    server.use(
      http.post(`${BASE}/v1/mpp/redeem`, ({ request }) => {
        seenIdem = request.headers.get('idempotency-key');
        return HttpResponse.json(response);
      }),
    );
    const result = await client().redeem(
      { credential: { challenge: { id: 'c1' } as never, payload: {}, source: 's' } },
      { idempotencyKey: 'idem-key-1' },
    );
    expect(result).toEqual(response);
    expect(seenIdem).toBe('idem-key-1');
  });

  it('POST /v1/mpp/redeem surfaces a problem body on the 200 result (failure is in the body)', async () => {
    const redeem: MppRedeemResponse = {
      problem: {
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Payment Verification Failed',
        status: 402,
        detail: 'HMAC mismatch',
      },
    };
    server.use(http.post(`${BASE}/v1/mpp/redeem`, () => HttpResponse.json(redeem)));
    const result = await client().redeem({ credential: { challenge: { id: 'x' } as never, payload: {}, source: 's' } });
    expect(result.problem?.detail).toBe('HMAC mismatch');
    expect(result.receipt).toBeUndefined();
  });

  it('GET /v1/transactions/{id}/mpp polls buyer state', async () => {
    const pending: MppTransactionResponse = { state: 'pending', retryAfterSeconds: 2, transactionId: 'tx-1' };
    server.use(http.get(`${BASE}/v1/transactions/tx-1/mpp`, () => HttpResponse.json(pending)));
    await expect(client().getTransaction('tx-1')).resolves.toEqual(pending);
  });
});

describe('error mapping', () => {
  it('maps a non-2xx response to InflowApiError, lifting an RFC 9457 problem body', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json(
          {
            type: 'https://paymentauth.org/problems/payment-expired',
            title: 'Payment Expired',
            status: 402,
            detail: 'challenge expired',
          },
          { status: 402, headers: { 'x-request-id': 'req-9' } },
        ),
      ),
    );
    const err = await client()
      .createTransaction({ challenge: { id: 'x' } as never, options: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InflowApiError);
    const apiError = err as InflowApiError;
    expect(apiError.httpStatus).toBe(402);
    expect(apiError.requestId).toBe('req-9');
    expect(apiError.problem?.title).toBe('Payment Expired');
    expect(apiError.message).toContain('challenge expired');
  });

  it('retries transient 503 then succeeds', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/v1/mpp/config`, () => {
        calls += 1;
        if (calls === 1) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ realm: 'inflow' });
      }),
    );
    await expect(client().getConfig()).resolves.toEqual({ realm: 'inflow' });
    expect(calls).toBe(2);
  });
});

describe('InflowHttpClient construction + transport', () => {
  it('rejects an empty API key', () => {
    expect(() => new InflowHttpClient({ apiKey: '   ' })).toThrow();
  });

  it('rejects apiKey + getAccessToken together', () => {
    expect(
      () => new InflowHttpClient({ apiKey: undefined, getAccessToken: () => Promise.resolve('t') } as never),
    ).not.toThrow();
    expect(() => new InflowHttpClient({ apiKey: 'k', getAccessToken: () => Promise.resolve('t') } as never)).toThrow();
  });

  it('sends a Bearer token from getAccessToken', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/v1/mpp/config`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ realm: 'inflow' });
      }),
    );
    const mpp = new MppClient({ getAccessToken: () => Promise.resolve('tok-abc'), environment: 'sandbox' });
    await mpp.getConfig();
    expect(auth).toBe('Bearer tok-abc');
  });

  it('throws a TIMEOUT-coded InflowApiError when the request exceeds timeoutMs', async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => reject(new Error('aborted', { cause: signal.reason })));
        }
      });
    const mpp = new MppClient({ apiKey: 'k', environment: 'sandbox', timeoutMs: 10, fetch: hangingFetch });
    const err = await mpp.getConfig({ retries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InflowApiError);
    expect((err as InflowApiError).code).toBe('TIMEOUT');
  });

  it('maps a terminal network error to NETWORK_ERROR', async () => {
    const failingFetch: typeof fetch = () => Promise.reject(new TypeError('connection refused'));
    const mpp = new MppClient({ apiKey: 'k', environment: 'sandbox', fetch: failingFetch });
    const err = await mpp.getConfig({ retries: 0 }).catch((e: unknown) => e);
    expect((err as InflowApiError).code).toBe('NETWORK_ERROR');
  });

  it('does not send X-API-KEY in anonymous mode', async () => {
    const spy = vi.fn<typeof fetch>(() => Promise.resolve(HttpResponse.json({ realm: 'inflow' })));
    const mpp = new MppClient({ environment: 'sandbox', fetch: spy });
    await mpp.getConfig();
    const headers = new Headers((spy.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.has('x-api-key')).toBe(false);
  });
});

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MppClient } from '../../src/index.js';
import type { PaymentStatusResponse } from '../../src/index.js';

const BASE = 'https://sandbox.inflowpay.ai';
const ID = '00000000-0000-0000-0000-000000000123';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client(bearer = false) {
  return Promise.resolve(
    new MppClient({
      environment: 'sandbox',
      ...(bearer ? { getAccessToken: () => Promise.resolve('buyer-token') } : { apiKey: 'buyer-key' }),
    }),
  );
}

describe('buyer payment status', () => {
  it('reads verification actions from the original payment without creating or cancelling it', async () => {
    const snapshot: PaymentStatusResponse = {
      transactionId: ID,
      status: 'PENDING',
      nextAction: { type: 'authenticate_card', url: `${BASE}/transactions/${ID}/verify/` },
    };
    let reads = 0;
    server.use(
      http.get(`${BASE}/v1/transactions/${ID}`, ({ request }) => {
        expect(request.headers.get('x-api-key')).toBe('buyer-key');
        reads++;
        return HttpResponse.json(snapshot);
      }),
    );
    const buyer = await client();
    expect(await buyer.getPaymentStatus(ID)).toEqual(snapshot);
    snapshot.status = 'SETTLED';
    delete snapshot.nextAction;
    expect(await buyer.getPaymentStatus(ID)).toEqual(snapshot);
    expect(reads).toBe(2);
  });

  it('preserves pending without an action and uses the buyer bearer token', async () => {
    server.use(
      http.get(`${BASE}/v1/transactions/${ID}`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer buyer-token');
        expect(request.headers.get('x-api-key')).toBeNull();
        return HttpResponse.json({ transactionId: ID, status: 'PROCESSING' });
      }),
    );
    const buyer = await client(true);
    expect(await buyer.getPaymentStatus(ID, {})).toEqual({ transactionId: ID, status: 'PROCESSING' });
  });

  it.each([401, 403, 503])('propagates HTTP %s without a default retry', async (status) => {
    let reads = 0;
    server.use(
      http.get(`${BASE}/v1/transactions/${ID}`, () => {
        reads++;
        return HttpResponse.json({ code: 'UNAVAILABLE', message: 'Payment status unavailable' }, { status });
      }),
    );
    const buyer = await client();
    await expect(buyer.getPaymentStatus(ID)).rejects.toMatchObject({ httpStatus: status });
    expect(reads).toBe(1);
  });

  it('honors an explicit retry setting without mutating caller options', async () => {
    let reads = 0;
    server.use(
      http.get(`${BASE}/v1/transactions/${ID}`, () =>
        ++reads === 1
          ? HttpResponse.json({}, { status: 503 })
          : HttpResponse.json({ transactionId: ID, status: 'PENDING' }),
      ),
    );
    const buyer = await client();
    const options = Object.freeze({ retries: 1 });
    expect((await buyer.getPaymentStatus(ID, options)).status).toBe('PENDING');
    expect(reads).toBe(2);
    expect(options).toEqual({ retries: 1 });
  });

  it('encodes identifiers as one path segment', async () => {
    server.use(
      http.get(`${BASE}/v1/transactions/:id`, ({ request }) => {
        expect(new URL(request.url).pathname).toBe('/v1/transactions/a%2Fb%3Fq%3Dx%23fragment');
        return HttpResponse.json({ transactionId: ID, status: 'PENDING' });
      }),
    );
    const buyer = await client();
    await buyer.getPaymentStatus('a/b?q=x#fragment');
  });

  it('does not follow a redirect or forward authentication to its target', async () => {
    const destination = vi.fn(() => HttpResponse.json({ status: 'SETTLED' }));
    server.use(
      http.get(
        `${BASE}/v1/transactions/${ID}`,
        () => new HttpResponse(null, { status: 307, headers: { Location: 'https://other.example/status' } }),
      ),
      http.get('https://other.example/status', destination),
    );
    const buyer = await client();
    await expect(buyer.getPaymentStatus(ID)).rejects.toMatchObject({ httpStatus: 307 });
    expect(destination).not.toHaveBeenCalled();
  });

  it('honors cancellation without cancelling the payment approval', async () => {
    const buyer = await client();
    await expect(buyer.getPaymentStatus(ID, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
  });
});

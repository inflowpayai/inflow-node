import { encodeCredential, InflowApiError } from '@inflowpayai/mpp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MppPaymentCancelledError, MppPaymentTimeoutError } from '../../src/errors.js';
import { inflow } from '../../src/methods.client.js';

const challenge = {
  id: 'challenge',
  realm: 'seller.test',
  method: 'inflow' as const,
  intent: 'charge' as const,
  request: { amount: '10', currency: 'USDC', recipient: '00000000-0000-0000-0000-000000000001' },
};

afterEach(() => vi.useRealTimers());

function pending() {
  return Response.json({
    state: 'pending',
    transactionId: 'transaction',
    approvalId: 'approval',
    retryAfterSeconds: 0,
  });
}

function blockedRequest(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) throw new Error('Expected an abort signal');
    const abort = () => reject(new DOMException('Request aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

describe('cancellation while HTTP is in progress', () => {
  it.each(['create', 'poll', 'authorize'] as const)(
    'cleanup aborts %s with the public cancellation error',
    async (stage) => {
      const started = vi.fn();
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.endsWith('/cancel')) return new Response(null, { status: 204 });
        if (stage === 'poll' && url.endsWith('/transactions/mpp')) return pending();
        started();
        return blockedRequest(init?.signal);
      };
      const subscription = inflow.subscription({ apiKey: 'key', fetch: fetchImpl });
      const charge = inflow({ apiKey: 'key', fetch: fetchImpl });
      const method = stage === 'authorize' ? subscription : charge;
      const payment =
        stage === 'authorize'
          ? subscription.createCredential({
              challenge: {
                ...challenge,
                intent: 'subscription',
                request: {
                  ...challenge.request,
                  periodUnit: 'month',
                  periodCount: 1,
                  subscriptionExpires: '2999-01-01T00:00:00Z',
                },
              },
              context: { subscriptionId: '00000000-0000-0000-0000-000000000001' },
            })
          : charge.createCredential({ challenge, context: {} });
      const result = payment.catch((error: unknown) => error);
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      method.cleanup();
      expect(await result).toBeInstanceOf(MppPaymentCancelledError);
      if (stage === 'poll')
        await vi.waitFor(() => expect(requests.some((url) => url.endsWith('/approvals/approval/cancel'))).toBe(true));
      else expect(requests).toHaveLength(1);
    },
  );

  it('bounds a stalled poll by the pending budget', async () => {
    vi.useFakeTimers();
    const polling = vi.fn();
    const requests: string[] = [];
    const method = inflow({
      apiKey: 'key',
      timeoutMs: 100,
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.endsWith('/transactions/mpp')) return pending();
        if (url.endsWith('/cancel')) return new Response(null, { status: 204 });
        polling();
        return blockedRequest(init?.signal);
      },
    });
    const payment = method.createCredential({ challenge, context: {} }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(polling).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(await payment).toMatchObject({
      name: 'MppPaymentTimeoutError',
      timeoutMs: 100,
      transactionId: 'transaction',
    });
    expect(requests.filter((url) => url.endsWith('/transaction/mpp'))).toHaveLength(1);
    expect(requests.some((url) => url.endsWith('/cancel'))).toBe(true);
  });

  it('preserves permanent API failures without retrying or converting them to cancellation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'FORBIDDEN', message: 'Denied' }, { status: 403 }));
    const method = inflow({ apiKey: 'key', fetch: fetchImpl });
    await expect(method.createCredential({ challenge, context: {} })).rejects.toBeInstanceOf(InflowApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([403, 503])('preserves a polling HTTP %s failure and cancels only the backing approval', async (status) => {
    const requests: string[] = [];
    const method = inflow({
      apiKey: 'key',
      fetch: (input) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.endsWith('/transactions/mpp')) return Promise.resolve(pending());
        if (url.endsWith('/cancel')) return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(Response.json({ code: 'POLL_FAILED', message: 'Poll failed' }, { status }));
      },
    });
    await expect(method.createCredential({ challenge, context: {} })).rejects.toMatchObject({
      httpStatus: status,
      code: 'POLL_FAILED',
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toContain('/approvals/approval/cancel');
  });

  it('rejects a ready response that arrives after the pending deadline', async () => {
    vi.useFakeTimers();
    const method = inflow({
      apiKey: 'key',
      timeoutMs: 100,
      fetch: (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/transactions/mpp')) return Promise.resolve(pending());
        if (url.endsWith('/cancel')) return Promise.resolve(new Response(null, { status: 204 }));
        vi.setSystemTime(Date.now() + 101);
        return Promise.resolve(Response.json({ state: 'ready', credential: 'must-not-be-used' }));
      },
    });
    const payment = method.createCredential({ challenge, context: {} }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(await payment).toBeInstanceOf(MppPaymentTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up concurrent requests and remains reusable afterwards', async () => {
    const started = vi.fn();
    const signals: AbortSignal[] = [];
    let allowReady = false;
    const credential = encodeCredential({
      challenge: { ...challenge, request: 'eyJ9' },
      payload: { transactionId: 't' },
      source: 'did:inflow:buyer',
    });
    const method = inflow({
      apiKey: 'key',
      fetch: async (_input, init) => {
        if (allowReady) return Response.json({ state: 'ready', credential });
        if (init?.signal) signals.push(init.signal);
        started();
        return blockedRequest(init?.signal);
      },
    });
    const payments = [1, 2].map(() =>
      method.createCredential({ challenge, context: {} }).catch((error: unknown) => error),
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
    method.cleanup();
    const results = await Promise.all(payments);
    expect(results.every((error) => error instanceof MppPaymentCancelledError)).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    allowReady = true;
    await expect(method.createCredential({ challenge, context: {} })).resolves.toMatch(/^Payment /);
    method.cleanup();
  });
});

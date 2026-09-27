import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInflowClient, decodeSolanaSecret, X402ApprovalTimeoutError } from '../../src/index.js';
import { createInflowSigner } from '../../src/signer.js';

afterEach(() => vi.restoreAllMocks());

const requirement = {
  scheme: 'balance',
  network: 'inflow:1',
  asset: '',
  amount: '1',
  payTo: 'seller',
  maxTimeoutSeconds: 300,
  extra: {},
};
const context = { resource: { url: 'https://seller.example/item' }, x402Version: 2 };
const ready = {
  status: 'PAID',
  encodedPayload: 'synthetic',
  paymentPayload: { x402Version: 2, accepted: requirement, payload: { transactionId: 'transaction' } },
};

async function prepare(poll: typeof fetch) {
  const client = await createInflowClient({
    apiKey: 'synthetic',
    fetch: async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith('x402-supported')) return Response.json({ kinds: [requirement] });
      if (path === '/v1/transactions/x402') {
        return Response.json({ approvalId: 'approval', transactionId: 'transaction', approvalStatus: 'PENDING' });
      }
      return poll(url, init);
    },
  });
  return client.prepareInflowPayment(requirement, context);
}

describe('polling error boundaries', () => {
  it('clears deadline timers after successful and rejected waits', async () => {
    const success = await prepare(() => Promise.resolve(Response.json(ready)));
    const denied = await prepare(() => Promise.resolve(Response.json({}, { status: 403 })));
    vi.useFakeTimers();
    try {
      await success.awaitPayload();
      expect(vi.getTimerCount()).toBe(0);
      await expect(denied.awaitPayload()).rejects.toMatchObject({ httpStatus: 403 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates credential-provider failures and permits another wait after recovery', async () => {
    const failure = new Error('credential unavailable');
    let fail = false;
    let requests = 0;
    const client = await createInflowClient({
      getAccessToken: () => {
        return fail ? Promise.reject(failure) : Promise.resolve('synthetic');
      },
      fetch: (url) => {
        requests++;
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        if (path.endsWith('x402-supported')) return Promise.resolve(Response.json({ kinds: [requirement] }));
        if (path.endsWith('/transactions/x402'))
          return Promise.resolve(
            Response.json({ approvalId: 'approval', transactionId: 'transaction', approvalStatus: 'PENDING' }),
          );
        return Promise.resolve(Response.json(ready));
      },
    });
    const payment = await client.prepareInflowPayment(requirement, context);
    fail = true;
    await expect(payment.awaitPayload()).rejects.toBe(failure);
    expect(requests).toBe(2);
    fail = false;
    await expect(payment.awaitPayload()).resolves.toMatchObject({ encodedPayload: 'synthetic' });
    expect(requests).toBe(3);
  });

  it('shares an expired capability refresh, retains routing on failure and permits retry', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signer = await createInflowSigner({
      apiKey: 'synthetic',
      fetch: async () => {
        calls++;
        if (calls === 2) {
          await wait;
          return Response.json({}, { status: 403 });
        }
        return Response.json({ kinds: [requirement] });
      },
    });
    await signer.ready();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
    const first = signer.getSupported();
    const second = signer.getSupported();
    const refresh = signer.refreshSupported();
    const observed = Promise.allSettled([first, second, refresh]);
    release?.();
    expect((await observed).every((result) => result.status === 'rejected')).toBe(true);
    expect(calls).toBe(2);
    expect(signer.supports(requirement)).toBe(true);
    await expect(signer.refreshSupported()).resolves.toEqual({ kinds: [requirement] });
    expect(calls).toBe(3);
  });

  it.each([301, 307, 308, 400, 401, 403, 404, 409, 422])(
    'preserves HTTP %i without retrying or cancelling',
    async (status) => {
      let calls = 0;
      const body = { errors: [{ code: 'DENIED', message: 'Access denied.' }] };
      const payment = await prepare(() => {
        calls++;
        return Promise.resolve(Response.json(body, { status }));
      });
      await expect(payment.awaitPayload()).rejects.toMatchObject({ httpStatus: status, body });
      expect(calls).toBe(1);
    },
  );

  it.each([429, 500, 502, 503, 504])('retries HTTP %i on the same transaction', async (status) => {
    let calls = 0;
    const payment = await prepare(() =>
      Promise.resolve(++calls === 1 ? Response.json({}, { status }) : Response.json(ready)),
    );
    await expect(payment.awaitPayload({ pollIntervalMs: 1 })).resolves.toEqual({
      encodedPayload: ready.encodedPayload,
      paymentPayload: ready.paymentPayload,
      transactionId: 'transaction',
    });
    expect(calls).toBe(2);
  });

  it('retries a network failure', async () => {
    let calls = 0;
    const payment = await prepare(() => {
      if (++calls === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(Response.json(ready));
    });
    await expect(payment.awaitPayload({ pollIntervalMs: 1 })).resolves.toEqual({
      encodedPayload: ready.encodedPayload,
      paymentPayload: ready.paymentPayload,
      transactionId: 'transaction',
    });
  });

  it('rejects a late payload even when custom fetch ignores cancellation', async () => {
    const payment = await prepare(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Response.json(ready);
    });
    await expect(payment.awaitPayload({ timeoutMs: 10 })).rejects.toBeInstanceOf(X402ApprovalTimeoutError);
  });

  it('interrupts a sleep longer than the deadline', async () => {
    const payment = await prepare(() => Promise.resolve(Response.json({ status: 'INITIATED' })));
    const start = Date.now();
    await expect(payment.awaitPayload({ timeoutMs: 20, pollIntervalMs: 10_000 })).rejects.toBeInstanceOf(
      X402ApprovalTimeoutError,
    );
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('does not include malformed secret input in diagnostics', () => {
    try {
      decodeSolanaSecret('[123, 234, SYNTHETIC_SECRET_MARKER]');
      expect.fail('Expected invalid JSON to fail');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'JSON parse failed' });
      expect(String(error)).not.toContain('123');
      expect(String(error)).not.toContain('SYNTHETIC');
    }
  });
});

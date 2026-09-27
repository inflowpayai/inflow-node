import { getEventListeners } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { InflowHttpClient, MppClient, type RequestOptions } from '../../src/index.js';

const challenge = { id: 'c1', realm: 'seller.test', method: 'inflow', intent: 'charge', request: 'e30' };

describe('request cancellation', () => {
  it('does not obtain credentials for an already cancelled request', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('token'));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new InflowHttpClient({ getAccessToken, fetch });
    await expect(client.get('/cancel', { signal: AbortSignal.abort('stopped') })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: '/cancel: network error — stopped',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send a request if cancelled while obtaining credentials', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new InflowHttpClient({
      getAccessToken: () => {
        controller.abort();
        return Promise.resolve('token');
      },
      fetch,
    });
    await expect(client.get('/cancel', { signal: controller.signal })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a custom fetch response returned after cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      controller.abort(new Error('stopped'));
      return Promise.resolve(Response.json({ ok: true }));
    });
    const client = new InflowHttpClient({ fetch });
    await expect(client.get('/cancel', { signal: controller.signal })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'status'])('interrupts %s retry backoff without another credential lookup', async (failure) => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const getAccessToken = vi.fn(() => Promise.resolve('token'));
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      if (failure === 'network') return Promise.reject(new TypeError('disconnected'));
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    const client = new InflowHttpClient({ fetch, getAccessToken });
    const result = expect(client.get('/retry', { signal: controller.signal })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: '/retry: network error — stopped',
    });
    await vi.waitFor(() => {
      expect(removeListener).toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    });
    controller.abort(new Error('stopped'));
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

describe('transport outcomes', () => {
  it('does not retry a custom transport AbortError without a caller signal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new DOMException('stopped', 'AbortError')));
    await expect(new InflowHttpClient({ fetch }).get('/abort')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves credential-provider failures without sending a request', async () => {
    const failure = new Error('vault unavailable');
    const getAccessToken = vi.fn(() => Promise.reject(failure));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new InflowHttpClient({ getAccessToken, fetch }).get('/auth')).rejects.toBe(failure);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads buyer-supported methods through the public client', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({ kinds: [] })));
    await expect(new MppClient({ fetch }).getSupported()).resolves.toEqual({ kinds: [] });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.inflowpay.ai/v1/transactions/mpp-supported');
  });
});

describe('mutating request defaults', () => {
  const calls = [
    [
      'transaction',
      (client: MppClient, options?: RequestOptions) => client.createTransaction({ challenge, options: {} }, options),
    ],
    [
      'authorization',
      (client: MppClient, options?: RequestOptions) => client.authorizeSubscription('sub-1', { challenge }, options),
    ],
  ] as const;

  it.each(calls)('%s is sent once on a transient status or network failure', async (_name, call) => {
    for (const failure of ['status', 'network']) {
      const fetch = vi.fn<typeof globalThis.fetch>(() => {
        if (failure === 'network') return Promise.reject(new TypeError('disconnected'));
        return Promise.resolve(new Response(null, { status: 503 }));
      });
      const client = new MppClient({ fetch });
      await expect(call(client)).rejects.toMatchObject({ httpStatus: failure === 'status' ? 503 : 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each(calls)('%s retains explicit retry overrides and does not mutate options', async (_name, call) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ state: 'pending', credential: 'value' }));
    const client = new MppClient({ fetch });
    const options = Object.freeze({ retries: 1, headers: Object.freeze({ 'X-Test': 'value' }) });
    await expect(call(client, options)).resolves.toMatchObject({ state: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(options).toEqual({ retries: 1, headers: { 'X-Test': 'value' } });
  });
});

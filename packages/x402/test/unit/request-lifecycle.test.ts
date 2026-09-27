import { getEventListeners } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { InflowApiError, InflowHttpClient } from '../../src/index.js';

describe('request cancellation', () => {
  it('rejects a non-string API key before sending a request', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    // JavaScript consumers can pass values outside the TypeScript constructor contract.
    const options = { apiKey: 123, fetch } as unknown as ConstructorParameters<typeof InflowHttpClient>[0];
    expect(() => new InflowHttpClient(options)).toThrow('`apiKey` must be a non-empty string');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not obtain credentials for an already cancelled request', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('token'));
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      new InflowHttpClient({ getAccessToken, fetch }).get('/cancel', {
        signal: AbortSignal.abort('stopped'),
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', cause: 'stopped' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not send a request after cancellation during credential lookup', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getAccessToken = vi.fn(() => {
      controller.abort();
      return Promise.resolve('token');
    });
    await expect(
      new InflowHttpClient({ getAccessToken, fetch }).get('/cancel', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['reject', 'resolve'])('does not retry or succeed when a cancelled transport will %s', async (outcome) => {
    const controller = new AbortController();
    const reason = new Error('stopped');
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      controller.abort(reason);
      return outcome === 'reject' ? Promise.reject(reason) : Promise.resolve(Response.json({ ok: true }));
    });
    const getAccessToken = vi.fn(() => Promise.resolve('token'));
    await expect(
      new InflowHttpClient({ getAccessToken, fetch }).get('/cancel', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', cause: reason });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['network', 'status'])('interrupts %s retry backoff without another credential lookup', async (failure) => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const getAccessToken = vi.fn(() => Promise.resolve('token'));
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      failure === 'network'
        ? Promise.reject(new TypeError('disconnected'))
        : Promise.resolve(new Response(null, { status: 503 })),
    );
    const result = expect(
      new InflowHttpClient({ fetch, getAccessToken }).get('/retry', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: '/retry: network error — stopped' });
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

  it('does not retry a transport AbortError without a caller signal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new DOMException('stopped', 'AbortError')));
    await expect(new InflowHttpClient({ fetch }).get('/abort')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('response parsing', () => {
  it.each([
    ['application/json', '{broken', '{broken'],
    ['text/plain', '{broken', '{broken'],
    ['text/plain', '{"ok":true}', { ok: true }],
    ['text/plain', '[1]', [1]],
  ])('preserves %s response %s', async (type, body, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(body, {
          headers: { 'content-type': type },
        }),
      ),
    );
    await expect(new InflowHttpClient({ fetch }).get('/parse')).resolves.toEqual(expected);
  });

  it.each([[], [null], ['bad'], [{ code: '', message: '' }]].map((errors) => ({ errors })))(
    'falls back for malformed error entries $errors',
    async ({ errors }) => {
      const body = { errors, code: 'FALLBACK', message: 'fallback' };
      const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json(body, { status: 400 })));
      await expect(new InflowHttpClient({ fetch }).get('/error')).rejects.toMatchObject({
        code: 'FALLBACK',
        message: 'fallback',
        body,
        httpStatus: 400,
      });
    },
  );

  it('preserves the platform error envelope and filters sensitive response headers', async () => {
    const body = { errors: [{ code: 'PARAMETER_REQUIRED', message: 'Amount is required.', parameter: 'amount' }] };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json(body, {
          status: 400,
          headers: { 'x-request-id': 'r1', 'set-cookie': 'secret' },
        }),
      ),
    );
    const failure: unknown = await new InflowHttpClient({ fetch }).get('/error').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InflowApiError);
    if (!(failure instanceof InflowApiError)) throw new Error('Expected InflowApiError');
    expect(failure).toMatchObject({
      code: 'PARAMETER_REQUIRED',
      message: 'Amount is required.',
      body,
      requestId: 'r1',
    });
    expect(failure.headers?.['x-request-id']).toBe('r1');
    expect(failure.headers).not.toHaveProperty('set-cookie');
  });
});

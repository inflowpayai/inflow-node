import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { InflowApiError } from '../../src/errors.js';
import { InflowHttpClient, type InflowClientOptions } from '../../src/http-client.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(overrides: Partial<InflowClientOptions> = {}) {
  return new InflowHttpClient({ apiKey: 'sk_test', ...overrides });
}

describe('InflowHttpClient construction', () => {
  it('throws when apiKey is present but empty', () => {
    expect(() => new InflowHttpClient({ apiKey: '' })).toThrow(/apiKey/u);
  });

  it('throws when apiKey is whitespace-only', () => {
    expect(() => new InflowHttpClient({ apiKey: '   ' })).toThrow(/apiKey/u);
    expect(() => new InflowHttpClient({ apiKey: '\t\n' })).toThrow(/apiKey/u);
  });

  it('accepts anonymous construction (apiKey omitted or undefined)', () => {
    // Authed-options shape with undefined apiKey is rejected by TS but allowed
    // at runtime when the anonymous-options shape is used (apiKey omitted
    // entirely). Both are valid anonymous transports — they send no
    // `X-API-KEY` header. Used by `createUnauthenticatedInflowFacilitator`.
    expect(() => new InflowHttpClient({ environment: 'production' })).not.toThrow();
    expect(() => new InflowHttpClient({ environment: 'production', apiKey: undefined })).not.toThrow();
  });

  it('resolves baseUrl from environment by default', () => {
    expect(makeClient().baseUrl).toBe(PROD_BASE);
    expect(makeClient({ environment: 'sandbox' }).baseUrl).toBe('https://sandbox.inflowpay.ai');
    expect(makeClient({ baseUrl: 'https://example.com/' }).baseUrl).toBe('https://example.com');
  });
});

describe('InflowHttpClient happy path', () => {
  it('GETs and parses JSON', async () => {
    server.use(http.get(`${PROD_BASE}/v1/x402/config`, () => HttpResponse.json({ ok: true, n: 1 })));
    const body = await makeClient().get<{ ok: boolean; n: number }>('/v1/x402/config');
    expect(body).toEqual({ ok: true, n: 1 });
  });

  it('POSTs JSON and parses JSON', async () => {
    server.use(
      http.post(`${PROD_BASE}/v1/x402/verify`, async ({ request }) => {
        expect(request.headers.get('content-type')).toBe('application/json');
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toEqual({ a: 1 });
        return HttpResponse.json({ isValid: true });
      }),
    );
    const result = await makeClient().post<{ isValid: boolean }>('/v1/x402/verify', { a: 1 });
    expect(result).toEqual({ isValid: true });
  });

  it('injects X-API-KEY, accept, and user-agent headers', async () => {
    let captured: Headers | undefined;
    server.use(
      http.get(`${PROD_BASE}/_h`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({});
      }),
    );
    await makeClient({ apiKey: 'sk_xyz' }).get('/_h');
    expect(captured?.get('x-api-key')).toBe('sk_xyz');
    expect(captured?.get('accept')).toBe('application/json');
    expect(captured?.get('user-agent')).toBe('@inflowpayai/x402 (node)');
  });

  it('forwards caller-supplied extra headers', async () => {
    let captured: Headers | undefined;
    server.use(
      http.get(`${PROD_BASE}/_h`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({});
      }),
    );
    await makeClient().get('/_h', { headers: { 'x-extra': 'value' } });
    expect(captured?.get('x-extra')).toBe('value');
  });

  it('treats an empty response body as undefined', async () => {
    server.use(http.get(`${PROD_BASE}/_empty`, () => new HttpResponse(null, { status: 200 })));
    await expect(makeClient().get('/_empty')).resolves.toBeUndefined();
  });
});

describe('InflowHttpClient error mapping', () => {
  it('throws InflowApiError on 4xx with code from body', async () => {
    server.use(
      http.get(`${PROD_BASE}/_fail`, () =>
        HttpResponse.json(
          { code: 'PARAMETER_INVALID', message: 'bad amount' },
          { status: 400, headers: { 'x-request-id': 'req_1' } },
        ),
      ),
    );
    try {
      await makeClient().get('/_fail');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InflowApiError);
      const e = err as InflowApiError;
      expect(e.code).toBe('PARAMETER_INVALID');
      expect(e.httpStatus).toBe(400);
      expect(e.requestId).toBe('req_1');
      expect(e.endpoint).toBe('/_fail');
      expect(e.message).toBe('bad amount');
    }
  });

  it('throws InflowApiError on 401 with UNEXPECTED_ERROR fallback when body has no code', async () => {
    server.use(http.get(`${PROD_BASE}/_unauth`, () => new HttpResponse('Unauthorized', { status: 401 })));
    try {
      await makeClient().get('/_unauth', { retries: 0 });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InflowApiError);
      const e = err as InflowApiError;
      expect(e.code).toBe('UNEXPECTED_ERROR');
      expect(e.httpStatus).toBe(401);
      expect(e.body).toBe('Unauthorized');
    }
  });

  it('throws InflowApiError on non-retryable 500', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_500`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'UNEXPECTED_ERROR' }, { status: 500 });
      }),
    );
    await expect(makeClient().get('/_500', { retries: 0 })).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(1);
  });
});

/**
 * Drain a retry-loop promise that's blocked on the http-client's `delay(setTimeout)` backoffs.
 *
 * `vi.useFakeTimers({ toFake: ['setTimeout'] })` (set up in the surrounding describe block) replaces the global
 * `setTimeout` so the backoff sleeps don't burn real wall-clock. But MSW's request interception still runs on real I/O,
 * so a single `runAllTimers()` call doesn't finish the retry loop — we have to alternate:
 *
 * Await pending fetch (real I/O via setImmediate) → drain queued setTimeout backoff (fake timer fires the next loop
 * iteration) → await next fetch → drain next backoff → …
 *
 * The loop terminates when the outer promise settles. Without this helper, the three former 1.5-second tests run in
 * milliseconds.
 */
async function settleFakeBackoff<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  // Observe settlement (fulfilled OR rejected) without consuming the rejection.
  // Using `.then(...)` with explicit handlers — rather than `.finally()` —
  // ensures the rejection is treated as handled, so Vitest won't report an
  // "unhandled rejection" when the outer caller eventually catches it.
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const hasSettled = (): boolean => settled;
  // Cap the drain loop so a broken test can't hang the suite.
  for (let i = 0; i < 100; i += 1) {
    if (hasSettled()) break;
    // Yield once so any in-flight fetch resolution callback can run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (vi.getTimerCount() > 0) {
      await vi.runAllTimersAsync();
    }
  }
  return promise;
}

describe('InflowHttpClient retry behavior', () => {
  beforeAll(() => {
    // Fake only setTimeout so MSW's request interception (which doesn't rely
    // on setTimeout in the hot path) keeps working.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('retries on 503 and succeeds on the second attempt', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_flaky`, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse('Service Unavailable', { status: 503 });
        }
        return HttpResponse.json({ ok: true });
      }),
    );
    const out = await settleFakeBackoff(makeClient().get<{ ok: boolean }>('/_flaky'));
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('retries up to 3 times then throws', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_always-503`, () => {
        calls += 1;
        return new HttpResponse('boom', { status: 503 });
      }),
    );
    await expect(settleFakeBackoff(makeClient().get('/_always-503'))).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it('does not retry on 400', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_400`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'PARAMETER_INVALID' }, { status: 400 });
      }),
    );
    await expect(settleFakeBackoff(makeClient().get('/_400'))).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(1);
  });

  it('retries on 429 and 502 and 504 as well', async () => {
    for (const status of [429, 502, 504] as const) {
      let calls = 0;
      server.use(
        http.get(`${PROD_BASE}/_${status}`, () => {
          calls += 1;
          if (calls === 1) return new HttpResponse('x', { status });
          return HttpResponse.json({ ok: true });
        }),
      );
      await expect(settleFakeBackoff(makeClient().get(`/_${status}`))).resolves.toEqual({ ok: true });
      expect(calls).toBe(2);
      server.resetHandlers();
    }
  });

  it('honors retries: 0 (used by buyer polling)', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_zero`, () => {
        calls += 1;
        return new HttpResponse('x', { status: 503 });
      }),
    );
    await expect(settleFakeBackoff(makeClient().get('/_zero', { retries: 0 }))).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(1);
  });

  it('caps retries at 3 even if the caller requests more', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/_cap`, () => {
        calls += 1;
        return new HttpResponse('x', { status: 503 });
      }),
    );
    await expect(settleFakeBackoff(makeClient().get('/_cap', { retries: 10 }))).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(4); // capped at 3 retries
  });
});

describe('InflowHttpClient timeout and abort', () => {
  it('aborts a request that exceeds the timeout', async () => {
    server.use(
      http.get(`${PROD_BASE}/_slow`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = makeClient({ timeoutMs: 30 });
    await expect(client.get('/_slow', { retries: 0 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      httpStatus: 0,
    });
  });

  it('honors caller-supplied AbortSignal', async () => {
    server.use(
      http.get(`${PROD_BASE}/_slow`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ ok: true });
      }),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('user-cancel')), 20);
    await expect(makeClient().get('/_slow', { signal: controller.signal, retries: 0 })).rejects.toBeInstanceOf(
      InflowApiError,
    );
  });
});

describe('InflowHttpClient fetch override', () => {
  it('uses the injected fetch when provided', async () => {
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = new InflowHttpClient({
      apiKey: 'sk_test',
      fetch: fakeFetch,
    });
    const out = await client.get<{ ok: boolean }>('/_x');
    expect(out).toEqual({ ok: true });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('InflowHttpClient bearer token — construction', () => {
  it('accepts a bearer-only options shape', () => {
    expect(() => new InflowHttpClient({ getAccessToken: () => Promise.resolve('tok') })).not.toThrow();
  });

  it('throws when both apiKey and getAccessToken are set', () => {
    expect(
      () =>
        new InflowHttpClient({
          // Caller error path: both fields present. The runtime narrowing rejects this even though the TS overloads
          // also reject it at compile time.
          apiKey: 'sk_test',
          getAccessToken: () => Promise.resolve('tok'),
        } as unknown as ConstructorParameters<typeof InflowHttpClient>[0]),
    ).toThrow(/mutually exclusive/u);
  });

  it('throws when getAccessToken is not a function', () => {
    expect(
      () =>
        new InflowHttpClient({
          getAccessToken: 5,
        } as unknown as ConstructorParameters<typeof InflowHttpClient>[0]),
    ).toThrow(/must be a function/u);
  });
});

describe('InflowHttpClient bearer token — request headers', () => {
  it('invokes getAccessToken and sends Authorization: Bearer <token>', async () => {
    const getAccessToken = vi.fn(() => Promise.resolve('access-1'));
    let captured: Headers | undefined;
    server.use(
      http.get(`${PROD_BASE}/_bearer`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new InflowHttpClient({ getAccessToken });
    await client.get('/_bearer');
    expect(captured?.get('authorization')).toBe('Bearer access-1');
    expect(captured?.get('x-api-key')).toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not send X-API-KEY when bearer mode is active', async () => {
    let captured: Headers | undefined;
    server.use(
      http.get(`${PROD_BASE}/_bearer`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json({});
      }),
    );
    const client = new InflowHttpClient({ getAccessToken: () => Promise.resolve('tok') });
    await client.get('/_bearer');
    expect(captured?.get('x-api-key')).toBeNull();
    expect(captured?.get('authorization')).toBe('Bearer tok');
  });

  it('throws verbatim when getAccessToken resolves to an empty string', async () => {
    let handlerCalls = 0;
    server.use(
      http.get(`${PROD_BASE}/_bearer`, () => {
        handlerCalls += 1;
        return HttpResponse.json({});
      }),
    );
    const client = new InflowHttpClient({ getAccessToken: () => Promise.resolve('') });
    await expect(client.get('/_bearer')).rejects.toThrow(/non-string or empty/u);
    // The bad token short-circuits before any fetch, so the handler is never hit.
    expect(handlerCalls).toBe(0);
  });
});

describe('InflowHttpClient bearer token — error propagation', () => {
  it('propagates getAccessToken rejection verbatim (not wrapped in InflowApiError)', async () => {
    class CallerAuthError extends Error {
      constructor() {
        super('caller-owned auth failure');
        this.name = 'CallerAuthError';
      }
    }
    const getAccessToken = vi.fn(() => Promise.reject(new CallerAuthError()));
    let handlerCalls = 0;
    server.use(
      http.get(`${PROD_BASE}/_bearer`, () => {
        handlerCalls += 1;
        return new HttpResponse('boom', { status: 503 });
      }),
    );
    const client = new InflowHttpClient({ getAccessToken });
    await expect(client.get('/_bearer')).rejects.toBeInstanceOf(CallerAuthError);
    // No retry: the rejection happens before any fetch, so the would-be-retried 503 handler is never invoked.
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(handlerCalls).toBe(0);
  });

  it('does not wrap getAccessToken rejection as an InflowApiError', async () => {
    const err = new Error('upstream auth provider down');
    server.use(http.get(`${PROD_BASE}/_bearer`, () => HttpResponse.json({})));
    const client = new InflowHttpClient({ getAccessToken: () => Promise.reject(err) });
    await expect(client.get('/_bearer')).rejects.toBe(err);
    await expect(client.get('/_bearer')).rejects.not.toBeInstanceOf(InflowApiError);
  });
});

describe('InflowHttpClient bearer token — per-attempt invocation on 5xx retry', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('re-invokes getAccessToken on each retry so a refreshed token can be picked up', async () => {
    let attempt = 0;
    const tokens: Headers[] = [];
    server.use(
      http.get(`${PROD_BASE}/_bearer-flaky`, ({ request }) => {
        tokens.push(request.headers);
        attempt += 1;
        if (attempt === 1) return new HttpResponse('boom', { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );
    let issued = 0;
    const getAccessToken = vi.fn(() => {
      issued += 1;
      return Promise.resolve(`tok-${issued}`);
    });
    const client = new InflowHttpClient({ getAccessToken });
    const out = await settleFakeBackoff(client.get<{ ok: boolean }>('/_bearer-flaky'));
    expect(out).toEqual({ ok: true });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(tokens[0]?.get('authorization')).toBe('Bearer tok-1');
    expect(tokens[1]?.get('authorization')).toBe('Bearer tok-2');
  });
});

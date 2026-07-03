import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { canonicalize, decode, parseChallengeHeader, renderChallengeHeader } from '../../src/codec.js';
import { readHeaderAll } from '../../src/constants.js';
import { InflowApiError, MppCodecError } from '../../src/errors.js';
import { InflowHttpClient, MppClient } from '../../src/http-client.js';

const BASE = 'https://sandbox.inflowpay.ai';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('codec branch coverage', () => {
  it('escapes the named C0 controls and a generic control via \\u00xx', () => {
    const input = `\b\f\r${String.fromCharCode(1)}`;
    expect(canonicalize({ s: input })).toBe('{"s":"\\b\\f\\r\\u0001"}');
  });

  it('serialises bigint and rejects unsupported value types', () => {
    expect(canonicalize({ n: 10n })).toBe('{"n":10}');
    expect(() => canonicalize(() => 0)).toThrow(MppCodecError);
  });

  it('rethrows an MppCodecError raised by re-padding during decode', () => {
    expect(() => decode('abcde', 'credential')).toThrow(MppCodecError);
  });

  it('rejects a description with a disallowed control character on render', () => {
    expect(() =>
      renderChallengeHeader({
        id: 'a',
        realm: 'r',
        method: 'inflow',
        intent: 'charge',
        request: 'q',
        description: 'bad\nline',
      }),
    ).toThrow(MppCodecError);
  });

  it('parses the digest param and ignores unknown params', () => {
    const parsed = parseChallengeHeader(
      'Payment id="a", realm="r", method="inflow", intent="charge", request="q", digest="sha-256=:x:", foo="bar"',
    );
    expect(parsed.digest).toBe('sha-256=:x:');
    expect('foo' in parsed).toBe(false);
  });
});

describe('errors / header helpers branch coverage', () => {
  it('readHeaderAll reads a WHATWG Headers instance', () => {
    expect(readHeaderAll(new Headers({ 'WWW-Authenticate': 'Payment id="a"' }), 'www-authenticate')).toEqual([
      'Payment id="a"',
    ]);
    expect(readHeaderAll(new Headers(), 'www-authenticate')).toEqual([]);
  });

  it('sanitises a WHATWG Headers instance and joins array record values', () => {
    const fromHeaders = InflowApiError.from({
      code: 'X',
      httpStatus: 500,
      endpoint: '/e',
      headers: new Headers({ authorization: 'Bearer secret', 'x-keep': 'yes' }),
    });
    expect(fromHeaders.headers?.['authorization']).toBeUndefined();
    expect(fromHeaders.headers?.['x-keep']).toBe('yes');

    const fromRecord = InflowApiError.from({
      code: 'X',
      httpStatus: 500,
      endpoint: '/e',
      headers: { 'x-multi': ['a', 'b'] },
    });
    expect(fromRecord.headers?.['x-multi']).toBe('a, b');
  });
});

function client(fetchImpl?: typeof fetch): MppClient {
  return new MppClient({ apiKey: 'k', environment: 'sandbox', ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

describe('http-client construction branch coverage', () => {
  it('rejects a non-string apiKey and a non-function getAccessToken', () => {
    expect(() => new InflowHttpClient({ apiKey: 123 } as never)).toThrow();
    expect(() => new InflowHttpClient({ getAccessToken: 'nope' } as never)).toThrow();
  });

  it('throws when getAccessToken resolves to an empty string', async () => {
    const mpp = new MppClient({ getAccessToken: () => Promise.resolve(''), environment: 'sandbox' });
    server.use(http.get(`${BASE}/v1/mpp/config`, () => HttpResponse.json({ realm: 'inflow' })));
    await expect(mpp.getConfig()).rejects.toThrow('non-string or empty');
  });
});

describe('http-client transport branch coverage', () => {
  it('extracts an application code and leaves problem undefined when the body has no problem shape', async () => {
    server.use(
      http.get(`${BASE}/v1/mpp/config`, () =>
        HttpResponse.json({ code: 'INSUFFICIENT_FUNDS', message: 'no funds' }, { status: 400 }),
      ),
    );
    const err = (await client()
      .getConfig()
      .catch((e: unknown) => e)) as InflowApiError;
    expect(err.code).toBe('INSUFFICIENT_FUNDS');
    expect(err.problem).toBeUndefined();
    expect(err.message).toContain('no funds');
  });

  it('carries problem extensions when present', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json(
          {
            type: 'https://paymentauth.org/problems/payment-insufficient',
            title: 'Payment Insufficient',
            status: 402,
            detail: 'short',
            extensions: { shortfall: '0.50' },
          },
          { status: 402 },
        ),
      ),
    );
    const err = (await client()
      .createTransaction({ challenge: { id: 'x' } as never, options: {} })
      .catch((e: unknown) => e)) as InflowApiError;
    expect(err.problem?.extensions).toEqual({ shortfall: '0.50' });
  });

  it('retries a transient network error then succeeds, threading a caller AbortSignal', async () => {
    let calls = 0;
    const flaky: typeof fetch = (url, init) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
      return globalThis.fetch(url, init);
    };
    server.use(http.get(`${BASE}/v1/mpp/config`, () => HttpResponse.json({ realm: 'inflow' })));
    const result = await client(flaky).getConfig({ signal: new AbortController().signal });
    expect(result).toEqual({ realm: 'inflow' });
    expect(calls).toBe(2);
  });

  it('does not retry a caller-driven abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const aborting: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal?.aborted) fail();
        else signal?.addEventListener('abort', fail);
      });
    const err = (await client(aborting)
      .getConfig({ signal: ac.signal, retries: 0 })
      .catch((e: unknown) => e)) as InflowApiError;
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('parses non-JSON, malformed-JSON, brace-prefixed, and empty bodies', async () => {
    const getBody = (): Promise<unknown> => client().getConfig();

    server.use(
      http.get(`${BASE}/v1/mpp/config`, () => new HttpResponse('plain', { headers: { 'content-type': 'text/plain' } })),
    );
    await expect(getBody()).resolves.toBe('plain');

    server.resetHandlers();
    server.use(
      http.get(
        `${BASE}/v1/mpp/config`,
        () => new HttpResponse('{bad', { headers: { 'content-type': 'application/json' } }),
      ),
    );
    await expect(getBody()).resolves.toBe('{bad');

    server.resetHandlers();
    server.use(
      http.get(
        `${BASE}/v1/mpp/config`,
        () => new HttpResponse('{"ok":true}', { headers: { 'content-type': 'text/plain' } }),
      ),
    );
    await expect(getBody()).resolves.toEqual({ ok: true });

    server.resetHandlers();
    server.use(http.get(`${BASE}/v1/mpp/config`, () => new HttpResponse(null, { status: 204 })));
    await expect(getBody()).resolves.toBeUndefined();
  });
});

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInflowSellerClient } from '../../src/seller-client.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

interface CallCounts {
  config: number;
  supported: number;
}

function installDefaultHandlers(counts: CallCounts = { config: 0, supported: 0 }): CallCounts {
  server.use(
    http.get(`${PROD_BASE}/v1/x402/config`, () => {
      counts.config += 1;
      return HttpResponse.json(SAMPLE_CONFIG);
    }),
    http.get(`${PROD_BASE}/v1/x402/supported`, () => {
      counts.supported += 1;
      return HttpResponse.json(SAMPLE_SUPPORTED);
    }),
  );
  return counts;
}

describe('createInflowSellerClient', () => {
  let counts: CallCounts;

  beforeEach(() => {
    counts = installDefaultHandlers();
  });

  it('primes both caches on construction in parallel (one config + one supported fetch)', async () => {
    await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(counts.config).toBe(1);
    expect(counts.supported).toBe(1);
  });

  it.each([false, true])('attaches the API key on outbound requests (provider: %s)', async (provider) => {
    let configAuth: string | null = null;
    let supportedAuth: string | null = null;
    server.use(
      http.get(`${PROD_BASE}/v1/x402/config`, ({ request }) => {
        configAuth = request.headers.get('x-api-key');
        return HttpResponse.json(SAMPLE_CONFIG);
      }),
      http.get(`${PROD_BASE}/v1/x402/supported`, ({ request }) => {
        supportedAuth = request.headers.get('x-api-key');
        return HttpResponse.json(SAMPLE_SUPPORTED);
      }),
    );
    await createInflowSellerClient({
      environment: 'production',
      apiKey: provider ? () => Promise.resolve('sk_test') : 'sk_test',
    });
    expect(configAuth).toBe('sk_test');
    expect(supportedAuth).toBe('sk_test');
  });

  it('subsequent config() reads hit the in-memory cache', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    const a = await client.config();
    const b = await client.config();
    expect(a).toBe(b);
    expect(counts.config).toBe(1); // only the prime
  });

  it('refreshConfig forces a refetch and replaces the cached value', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    await client.refreshConfig();
    expect(counts.config).toBe(2);
  });

  it('refreshSupported forces a refetch and replaces the cached value', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    await client.refreshSupported();
    expect(counts.supported).toBe(2);
  });

  it('shares in-flight refresh across concurrent callers (config)', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    const [a, b, c] = await Promise.all([client.refreshConfig(), client.refreshConfig(), client.refreshConfig()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counts.config).toBe(2); // 1 prime + 1 shared refresh
  });

  it('shares in-flight refresh across concurrent callers (supported)', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    const [a, b, c] = await Promise.all([
      client.refreshSupported(),
      client.refreshSupported(),
      client.refreshSupported(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(counts.supported).toBe(2);
  });

  it('getSignerAddresses returns the exact match', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(await client.getSignerAddresses('eip155:8453')).toEqual(['0xSigner1', '0xSigner2']);
  });

  it('getSignerAddresses falls back to CAIP-2 family wildcard', async () => {
    server.resetHandlers();
    installDefaultHandlers(counts);
    server.use(
      http.get(`${PROD_BASE}/v1/x402/supported`, () =>
        HttpResponse.json({
          kinds: SAMPLE_SUPPORTED.kinds,
          extensions: ['payment-identifier'],
          signers: { 'eip155:*': ['0xWildcardSigner'] },
        }),
      ),
    );
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(await client.getSignerAddresses('eip155:99999')).toEqual(['0xWildcardSigner']);
  });

  it('getSignerAddresses returns [] for an unknown network', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(await client.getSignerAddresses('cosmos:cosmoshub-4')).toEqual([]);
  });

  it('getSignerAddresses does not wildcard-fallback for non-CAIP-2 inputs', async () => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(await client.getSignerAddresses('not-caip-2')).toEqual([]);
  });

  it('returns no signers when the supported response omits the signer table', async () => {
    server.use(http.get(`${PROD_BASE}/v1/x402/supported`, () => HttpResponse.json({ kinds: [], extensions: [] })));
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    expect(await client.getSignerAddresses('eip155:8453')).toEqual([]);
  });

  it.each(['config', 'supported'] as const)('refreshes expired %s once for concurrent readers', async (cache) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    const read = () => (cache === 'config' ? client.config() : client.getSignerAddresses('eip155:8453'));
    const original = await read();
    now.mockReturnValue(1000 + 60 * 60 * 1000 - 1);
    expect(await read()).toBe(original);
    expect(counts[cache]).toBe(1);
    now.mockReturnValue(1000 + 60 * 60 * 1000);
    const [first, second] = await Promise.all([read(), read()]);
    expect(first).toEqual(original);
    expect(first).not.toBe(original);
    expect(second).toBe(first);
    expect(counts[cache]).toBe(2);
    expect(await read()).toBe(first);
  });

  it.each(['config', 'supported'] as const)('recovers after a failed expired %s refresh', async (cache) => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    now.mockReturnValue(1000 + 60 * 60 * 1000);
    let fail = true;
    let attempts = 0;
    server.use(
      http.get(`${PROD_BASE}/v1/x402/${cache}`, () => {
        attempts += 1;
        return fail
          ? HttpResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 })
          : HttpResponse.json(cache === 'config' ? SAMPLE_CONFIG : SAMPLE_SUPPORTED);
      }),
    );
    const read = () => (cache === 'config' ? client.config() : client.getSignerAddresses('eip155:8453'));
    const results = await Promise.allSettled([read(), read()]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(attempts).toBe(1);
    fail = false;
    const recovered = await read();
    expect(await read()).toBe(recovered);
    expect(attempts).toBe(2);
  });

  it.each(['config', 'supported'] as const)('retains valid %s data after a failed forced refresh', async (cache) => {
    const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
    const read = () => (cache === 'config' ? client.config() : client.getSignerAddresses('eip155:8453'));
    const original = await read();
    server.use(
      http.get(`${PROD_BASE}/v1/x402/${cache}`, () => HttpResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 })),
    );
    const refresh = () => (cache === 'config' ? client.refreshConfig() : client.refreshSupported());
    await expect(refresh()).rejects.toMatchObject({ httpStatus: 401 });
    expect(await read()).toBe(original);
    server.resetHandlers();
    installDefaultHandlers();
    await refresh();
    expect(await read()).toEqual(original);
    expect(await read()).not.toBe(original);
  });
});

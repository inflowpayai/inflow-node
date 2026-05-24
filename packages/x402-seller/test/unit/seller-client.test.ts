import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createInflowSellerClient } from '../../src/seller-client.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
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

  it('attaches the API key on outbound requests', async () => {
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
    await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
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
});

import { MppClient } from '@inflowpayai/mpp';
import type { MppConfigResponse } from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createConfigClient } from '../../src/config-client.js';

const BASE = 'https://mpp.test';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function config(overrides: Partial<MppConfigResponse> = {}): MppConfigResponse {
  return {
    sellerId: '22222222-2222-2222-2222-222222222222',
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: 'psp' },
    supportedMethods: [
      {
        id: 'inflow',
        label: 'InFlow',
        methodDetails: {
          intentCurrencyRails: {
            charge: {
              USDC: [{ rail: 'balance' }],
              USD: [{ rail: 'instrument', instrumentId: 'optional' }],
            },
          },
          currencyRails: {
            USDC: { rail: 'balance' },
            USD: { rail: 'instrument', instrumentId: 'optional' },
          },
        },
        supportedCurrencies: ['USDC', 'USD'],
        supportedIntents: ['charge'],
      },
    ],
    ...overrides,
  };
}

function mockConfig(body: MppConfigResponse, onHit?: () => void): void {
  server.use(
    http.get(`${BASE}/v1/mpp/config`, () => {
      onHit?.();
      return HttpResponse.json(body);
    }),
  );
}

function client(): MppClient {
  return new MppClient({ apiKey: 'sk_test', baseUrl: BASE });
}

describe('createConfigClient', () => {
  it('loads config through an API-key provider', async () => {
    const apiKey = vi.fn(() => Promise.resolve('provider-key'));
    server.use(
      http.get(`${BASE}/v1/mpp/config`, ({ request }) => {
        expect(request.headers.get('X-API-KEY')).toBe('provider-key');
        return HttpResponse.json(config());
      }),
    );
    const c = createConfigClient(new MppClient({ apiKey, baseUrl: BASE }));
    await c.load();
    await c.load();
    expect(apiKey).toHaveBeenCalledTimes(1);
  });

  it('loads and exposes the consumed config slice', async () => {
    mockConfig(config());
    const loaded = await createConfigClient(client()).load();
    expect(loaded.sellerId).toBe('22222222-2222-2222-2222-222222222222');
    expect(loaded.featureFlags.idempotencyKeyEnabled).toBe(true);
    expect(loaded.currencyRails['USDC']).toEqual({ rail: 'balance' });
    expect(loaded.currencyRails['USD']).toEqual({ rail: 'instrument', instrumentId: 'optional' });
    expect(loaded.intentCurrencyRails['charge']?.['USDC']).toEqual([{ rail: 'balance' }]);
  });

  it('fetches once and memoises across calls', async () => {
    let hits = 0;
    mockConfig(config(), () => (hits += 1));
    const c = createConfigClient(client());
    await c.load();
    await c.load();
    expect(hits).toBe(1);
  });

  it('returns an empty rail map when the PSP advertises no inflow method', async () => {
    mockConfig(config({ supportedMethods: [] }));
    const loaded = await createConfigClient(client()).load();
    expect(loaded.currencyRails).toEqual({});
    expect(loaded.intentCurrencyRails).toEqual({});
  });

  it('shares failures and retries on a later load without refreshing successful config', async () => {
    let hits = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${BASE}/v1/mpp/config`, async () => {
        hits += 1;
        if (hits === 1) {
          await pending;
          return HttpResponse.json({ code: 'UNAVAILABLE', message: 'Try later.' }, { status: 500 });
        }
        return HttpResponse.json(config());
      }),
    );
    const c = createConfigClient(client());
    const first = c.load();
    const second = c.load();
    expect(second).toBe(first);
    const failed = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(hits).toBe(1));
    if (release === undefined) throw new Error('Expected pending response');
    release();
    const results = await failed;
    expect(results).toMatchObject([{ status: 'rejected' }, { status: 'rejected' }]);
    if (results[0].status !== 'rejected' || results[1].status !== 'rejected') throw new Error('expected failures');
    expect(results[0].reason).toBe(results[1].reason);

    const retry = c.load();
    expect(c.load()).toBe(retry);
    const loaded = await retry;
    expect(loaded.sellerId).toBe(config().sellerId);
    expect(await c.load()).toBe(loaded);
    expect(hits).toBe(2);
  });
});

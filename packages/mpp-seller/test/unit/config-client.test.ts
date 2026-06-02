import { MppClient } from '@inflowpayai/mpp';
import type { MppConfigResponse } from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
  it('loads and exposes the consumed config slice', async () => {
    mockConfig(config());
    const loaded = await createConfigClient(client()).load();
    expect(loaded.sellerId).toBe('22222222-2222-2222-2222-222222222222');
    expect(loaded.featureFlags.idempotencyKeyEnabled).toBe(true);
    expect(loaded.currencyRails.USDC).toEqual({ rail: 'balance' });
    expect(loaded.currencyRails.USD).toEqual({ rail: 'instrument', instrumentId: 'optional' });
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
  });
});

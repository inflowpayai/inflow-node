import { MppClient, MppProtocolVersionError } from '@inflowpayai/mpp';
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
    featureFlags: { idempotencyKeyEnabled: true },
    minSdkVersion: '0.1.0',
    protocolVersion: '1.0',
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
  it('loads, version-gates, and exposes the consumed config slice', async () => {
    mockConfig(config());
    const loaded = await createConfigClient(client()).load();
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

  it('throws on a protocol-version mismatch', async () => {
    mockConfig(config({ protocolVersion: '2.0' }));
    await expect(createConfigClient(client()).load()).rejects.toBeInstanceOf(MppProtocolVersionError);
  });

  it('throws when this SDK is below the PSP minimum', async () => {
    mockConfig(config({ minSdkVersion: '9.9.9' }));
    await expect(createConfigClient(client()).load()).rejects.toMatchObject({ kind: 'sdk' });
  });

  it('accepts a PSP minimum at or below this SDK (no gate)', async () => {
    mockConfig(config({ minSdkVersion: '0.0.1' }));
    await expect(createConfigClient(client()).load()).resolves.toMatchObject({
      currencyRails: { USDC: { rail: 'balance' } },
    });
  });

  it('throws when a single-segment PSP minimum outranks this SDK', async () => {
    // `parseCore` reads the missing minor/patch as 0; `1` (i.e. 1.0.0) is above this SDK's 0.1.0.
    mockConfig(config({ minSdkVersion: '1' }));
    await expect(createConfigClient(client()).load()).rejects.toMatchObject({ kind: 'sdk' });
  });

  it('treats a non-numeric PSP minimum as 0.0.0 (does not gate)', async () => {
    mockConfig(config({ minSdkVersion: 'not.a.version' }));
    await expect(createConfigClient(client()).load()).resolves.toMatchObject({
      featureFlags: { idempotencyKeyEnabled: true },
    });
  });

  it('replays the same gate rejection without re-fetching', async () => {
    let hits = 0;
    mockConfig(config({ protocolVersion: '2.0' }), () => (hits += 1));
    const c = createConfigClient(client());
    await expect(c.load()).rejects.toBeInstanceOf(MppProtocolVersionError);
    await expect(c.load()).rejects.toBeInstanceOf(MppProtocolVersionError);
    expect(hits).toBe(1);
  });
});

import type { AssetAmount, Network, PaymentRequirements, Price, SupportedKind } from '@x402/core/types';
import { resolvePaymentFlow } from '@x402/core/server';
import { describe, expect, it } from 'vitest';

import type { InflowSellerClient } from '../../src/seller-client.js';
import { inflowSchemeRegistrations, type InflowSchemeRegistration } from '../../src/scheme-registrations.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';

/**
 * Build a minimal `InflowSellerClient` stub that only implements `config()`. The other methods aren't used by
 * `inflowSchemeRegistrations` so they're stubbed to reject and surface any accidental use as a test failure.
 */
function fakeSellerClient(config: typeof SAMPLE_CONFIG = SAMPLE_CONFIG): InflowSellerClient {
  return {
    config: () => Promise.resolve(config),
    refreshConfig: () => Promise.reject(new Error('refreshConfig: not stubbed')),
    refreshSupported: () => Promise.reject(new Error('refreshSupported: not stubbed')),
    getSignerAddresses: () => Promise.reject(new Error('getSignerAddresses: not stubbed')),
  };
}

/**
 * Extract the `(scheme, network)` pairs from a registration array as plain tuples for easy assertion. Order matters:
 * insertion order is preserved.
 */
function pairs(registrations: readonly InflowSchemeRegistration[]): Array<[string, Network]> {
  return registrations.map((r) => [r.server.scheme, r.network]);
}

function registrationFor(
  registrations: readonly InflowSchemeRegistration[],
  scheme: string,
  network: Network,
): InflowSchemeRegistration {
  const registration = registrations.find(
    (candidate) => candidate.server.scheme === scheme && candidate.network === network,
  );
  if (registration === undefined) {
    throw new Error(`Missing registration for ${scheme} on ${network}`);
  }
  return registration;
}

describe('inflowSchemeRegistrations', () => {
  it('emits one (scheme, network) registration per distinct asset network and payment method', async () => {
    const client = fakeSellerClient();
    const registrations = await inflowSchemeRegistrations(client);

    // SAMPLE_CONFIG has:
    //  - assets on eip155:8453 (USDC + USDT) → dedupes to one (exact, eip155:8453)
    //  - asset on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp → (exact, solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
    //  - paymentMethods: balance / inflow:1 → (balance, inflow:1)
    expect(pairs(registrations)).toEqual([
      ['exact', 'eip155:8453'],
      ['exact', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      ['balance', 'inflow:1'],
    ]);
  });

  it('returns an empty array when the seller config has no assets and no payment methods', async () => {
    const client = fakeSellerClient({
      ...SAMPLE_CONFIG,
      assets: [],
      paymentMethods: [],
    });
    const registrations = await inflowSchemeRegistrations(client);
    expect(registrations).toEqual([]);
  });

  it('dedupes (scheme, network) pairs even when payment methods duplicate an on-chain entry', async () => {
    // Push a synthetic paymentMethod with the same (exact, eip155:8453)
    // pair already produced by the on-chain assets — the second add() call
    // must collapse into the existing registration.
    const client = fakeSellerClient({
      ...SAMPLE_CONFIG,
      paymentMethods: [
        ...SAMPLE_CONFIG.paymentMethods,
        // Inline literal — the dedupe path only reads `scheme` and `network`, but the full PaymentMethodInfo shape
        // is satisfied here so no cast is needed.
        {
          scheme: 'exact',
          network: 'eip155:8453',
          payTo: '0xPayTo000000000000000000000000000000000007',
          decimals: 6,
        },
      ],
    });
    const registrations = await inflowSchemeRegistrations(client);
    // Still exactly three: dedupe collapsed the duplicate.
    expect(registrations).toHaveLength(3);
    expect(pairs(registrations)).toEqual([
      ['exact', 'eip155:8453'],
      ['exact', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      ['balance', 'inflow:1'],
    ]);
    const exact = registrationFor(registrations, 'exact', 'eip155:8453');
    expect(exact.server.defaultAssetTransferMethod).toBe('eip3009');
    expect(Object.keys(exact.server.paymentFlows)).toEqual(['eip3009', 'permit2', 'default']);
  });

  it('each registration exposes a passthrough server with parsePrice + enhancePaymentRequirements hooks', async () => {
    const client = fakeSellerClient();
    const registrations = await inflowSchemeRegistrations(client);
    for (const reg of registrations) {
      expect(typeof reg.server.scheme).toBe('string');
      expect(typeof reg.server.parsePrice).toBe('function');
      expect(typeof reg.server.enhancePaymentRequirements).toBe('function');
    }
  });

  it('declares authorization-only payment flows for exactly the transfer methods emitted by seller config', async () => {
    const registrations = await inflowSchemeRegistrations(fakeSellerClient());

    const base = registrationFor(registrations, 'exact', 'eip155:8453');
    expect(base.server.defaultAssetTransferMethod).toBe('eip3009');
    expect(base.server.paymentFlows).toEqual({
      eip3009: { supported: ['authorization'], default: 'authorization' },
      permit2: { supported: ['authorization'], default: 'authorization' },
    });

    const solana = registrationFor(registrations, 'exact', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(solana.server.defaultAssetTransferMethod).toBe('solana');
    expect(solana.server.paymentFlows).toEqual({
      solana: { supported: ['authorization'], default: 'authorization' },
    });

    const balance = registrationFor(registrations, 'balance', 'inflow:1');
    expect(balance.server.defaultAssetTransferMethod).toBe('default');
    expect(balance.server.paymentFlows).toEqual({
      default: { supported: ['authorization'], default: 'authorization' },
    });
  });

  it('derives a non-blockchain transfer method from PaymentMethodInfo.extra', async () => {
    const registrations = await inflowSchemeRegistrations(
      fakeSellerClient({
        ...SAMPLE_CONFIG,
        paymentMethods: [
          {
            ...SAMPLE_CONFIG.paymentMethods[0]!,
            extra: { assetTransferMethod: 'ledger-v2' },
          },
        ],
      }),
    );

    const balance = registrationFor(registrations, 'balance', 'inflow:1');
    expect(balance.server.defaultAssetTransferMethod).toBe('ledger-v2');
    expect(balance.server.paymentFlows).toEqual({
      'ledger-v2': { supported: ['authorization'], default: 'authorization' },
    });
  });

  it('stores __proto__ as an own transfer-method key without invoking its setter', async () => {
    const registrations = await inflowSchemeRegistrations(
      fakeSellerClient({
        ...SAMPLE_CONFIG,
        paymentMethods: [
          {
            ...SAMPLE_CONFIG.paymentMethods[0]!,
            extra: { assetTransferMethod: '__proto__' },
          },
        ],
      }),
    );

    const balance = registrationFor(registrations, 'balance', 'inflow:1');
    expect(Object.hasOwn(balance.server.paymentFlows, '__proto__')).toBe(true);
    expect(balance.server.paymentFlows['__proto__']).toEqual({
      supported: ['authorization'],
      default: 'authorization',
    });
  });

  it('uses a null-prototype payment-flow table so inherited keys are rejected descriptively', async () => {
    const registrations = await inflowSchemeRegistrations(fakeSellerClient());
    const balance = registrationFor(registrations, 'balance', 'inflow:1');

    expect(Object.getPrototypeOf(balance.server.paymentFlows)).toBeNull();
    expect(() =>
      resolvePaymentFlow(balance.server, {
        scheme: 'balance',
        network: 'inflow:1',
        asset: 'USD',
        amount: '1',
        payTo: 'acct_test',
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: 'toString' },
      }),
    ).toThrow(/does not support assetTransferMethod "toString"/);
  });
});

describe('inflowSchemeRegistrations — passthrough scheme.parsePrice', () => {
  async function getExactServer(): Promise<InflowSchemeRegistration['server']> {
    const registrations = await inflowSchemeRegistrations(fakeSellerClient());
    const exact = registrations.find((r) => r.server.scheme === 'exact');
    if (exact === undefined) throw new Error('expected an exact registration');
    return exact.server;
  }

  it('returns the AssetAmount unchanged when no extra is present', async () => {
    const server = await getExactServer();
    const input: AssetAmount = {
      asset: '0xUSDC_Base_address_000000000000000000000a',
      amount: '1000000',
    };
    const out = await server.parsePrice(input, 'eip155:8453');
    expect(out).toEqual({
      asset: '0xUSDC_Base_address_000000000000000000000a',
      amount: '1000000',
    });
    // `extra` must NOT be on the output object when absent in the input —
    // this exercises the explicit-reassembly branch added for
    // `exactOptionalPropertyTypes`.
    expect('extra' in out).toBe(false);
  });

  it('preserves the extra block when one is present on the input', async () => {
    const server = await getExactServer();
    const extra = {
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: 'eip3009',
    };
    const input: AssetAmount = {
      asset: '0xUSDC_Base_address_000000000000000000000a',
      amount: '1000000',
      extra,
    };
    const out = await server.parsePrice(input, 'eip155:8453');
    expect(out).toEqual({
      asset: '0xUSDC_Base_address_000000000000000000000a',
      amount: '1000000',
      extra,
    });
  });

  it('rejects a Money-form (string) price with a descriptive error', async () => {
    const server = await getExactServer();
    await expect(server.parsePrice('$1.00', 'eip155:8453')).rejects.toThrow(
      /parsePrice expected AssetAmount-form price/,
    );
  });

  it('rejects null', async () => {
    const server = await getExactServer();
    await expect(server.parsePrice(null as unknown as Price, 'eip155:8453')).rejects.toThrow(
      /parsePrice expected AssetAmount-form price/,
    );
  });

  it('rejects an object missing the asset field', async () => {
    const server = await getExactServer();
    await expect(server.parsePrice({ amount: '1000000' } as unknown as Price, 'eip155:8453')).rejects.toThrow(
      /parsePrice expected AssetAmount-form price/,
    );
  });

  it('rejects an object missing the amount field', async () => {
    const server = await getExactServer();
    await expect(server.parsePrice({ asset: '0xUSDC' } as unknown as Price, 'eip155:8453')).rejects.toThrow(
      /parsePrice expected AssetAmount-form price/,
    );
  });
});

describe('inflowSchemeRegistrations — passthrough scheme.enhancePaymentRequirements', () => {
  it('returns the input PaymentRequirements unchanged (identity passthrough)', async () => {
    const registrations = await inflowSchemeRegistrations(fakeSellerClient());
    const reg = registrations[0];
    expect(reg).toBeDefined();

    // Minimal PaymentRequirements skeleton — structural shape only.
    const requirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      maxAmountRequired: '1000000',
      resource: 'https://example.com/api/widgets',
      description: 'Test',
      mimeType: 'application/json',
      payTo: '0xPayTo000000000000000000000000000000000007',
      asset: '0xUSDC_Base_address_000000000000000000000a',
      maxTimeoutSeconds: 60,
    } as unknown as PaymentRequirements;

    const supportedKind = {
      scheme: 'exact',
      network: 'eip155:8453',
      x402Version: 2,
    } as unknown as SupportedKind;

    const out = await reg!.server.enhancePaymentRequirements(requirements, supportedKind, ['payment-identifier']);
    // Identity: same reference returned, no mutation.
    expect(out).toBe(requirements);
  });
});

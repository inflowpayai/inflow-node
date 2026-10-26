import { resolvePaymentFlow } from '@x402/core/server';
import { describe, expect, it } from 'vitest';

import { inflowAccepts, inflowRoute, inflowSchemeRegistrations } from '../../src/index.js';
import { supportsUpfront } from '../../src/payment-flow.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';
import { UPTO_CONFIG } from '../fixtures/upto-config.js';

describe('payment flow selection', () => {
  it.each([
    ['exact', 'eip155:8453', 'eip3009', true],
    ['exact', 'eip155:84532', 'permit2', true],
    ['exact', 'eip155:8453', undefined, true],
    ['exact', 'eip155:8453', 'other', false],
    ['exact', 'solana:devnet', 'solana', true],
    ['exact', 'solana:devnet', undefined, true],
    ['exact', 'solana:devnet', 'permit2', false],
    ['exact', 'other:1', undefined, false],
    ['balance', 'inflow:1', undefined, true],
    ['instrument', 'inflow:1', undefined, true],
    ['balance', 'inflow:1', 'ledger-v2', false],
    ['balance', 'other:1', undefined, false],
    ['upto', 'eip155:8453', 'permit2', false],
    ['unknown', 'inflow:1', undefined, false],
  ])('supports %s / %s / %s: %s', (scheme, network, method, expected) => {
    expect(supportsUpfront(scheme, network, method)).toBe(expected);
  });

  it('leaves authorization offers unchanged and adds upfront without mutating cached config', async () => {
    const client = fakeSellerClient();
    const original = structuredClone(SAMPLE_CONFIG);
    const defaults = await inflowAccepts(client, { price: '$1' });
    expect(await inflowAccepts(client, { price: '$1', paymentFlow: 'authorization' })).toEqual(defaults);
    const upfront = await inflowAccepts(client, { price: '$1', paymentFlow: 'upfront' });
    expect(upfront).toEqual(defaults.map((entry) => ({ ...entry, extra: { ...entry.extra, paymentFlow: 'upfront' } })));
    expect(SAMPLE_CONFIG).toEqual(original);
    expect(await inflowAccepts(client, { price: '$1' })).toEqual(defaults);
  });

  it('passes the option through inflowRoute', async () => {
    const client = fakeSellerClient();
    const route = await inflowRoute(client, { price: '$1', paymentFlow: 'upfront' });
    expect(route.accepts).toEqual(await inflowAccepts(client, { price: '$1', paymentFlow: 'upfront' }));
  });

  it('advertises upfront Instrument requirements and resolves their execution order', async () => {
    const client = fakeSellerClient({
      ...SAMPLE_CONFIG,
      paymentMethods: [{ scheme: 'instrument', network: 'inflow:1', payTo: SAMPLE_CONFIG.sellerId, decimals: 18 }],
    });
    const offers = await inflowAccepts(client, { price: '$1', schemes: ['instrument'], paymentFlow: 'upfront' });
    expect(offers).toMatchObject([{ extra: { paymentFlow: 'upfront' } }]);
    const registration = (await inflowSchemeRegistrations(client, { schemes: ['instrument'] }))[0];
    if (registration === undefined) throw new Error('Missing Instrument registration');
    expect(
      resolvePaymentFlow(registration.server, {
        scheme: 'instrument',
        network: 'inflow:1',
        asset: 'USD',
        amount: '1000000000000000000',
        payTo: SAMPLE_CONFIG.sellerId,
        maxTimeoutSeconds: 300,
        extra: { paymentFlow: 'upfront' },
      }),
    ).toMatchObject({ paymentFlow: 'upfront' });
  });

  it('rejects upfront metered offers instead of silently reverting to authorization', async () => {
    await expect(
      inflowAccepts(fakeSellerClient(UPTO_CONFIG), {
        price: '$1',
        schemes: ['upto'],
        paymentFlow: 'upfront',
      }),
    ).rejects.toThrow('Upfront payment is unsupported for upto on eip155:8453');
  });

  it('rejects unknown transfer methods for upfront but preserves their authorization support', async () => {
    const client = fakeSellerClient({
      ...SAMPLE_CONFIG,
      assets: [],
      paymentMethods: [
        {
          scheme: 'instrument',
          network: 'inflow:1',
          payTo: SAMPLE_CONFIG.sellerId,
          decimals: 18,
          extra: { assetTransferMethod: 'other' },
        },
      ],
    });
    await expect(
      inflowAccepts(client, { price: '$1', schemes: ['instrument'], paymentFlow: 'upfront' }),
    ).rejects.toThrow('Upfront payment is unsupported');
    expect(await inflowAccepts(client, { price: '$1', schemes: ['instrument'] })).toHaveLength(1);
  });

  it('rejects an invalid runtime flow rather than charging under a different flow', async () => {
    // JavaScript callers can supply values outside the TypeScript union.
    const paymentFlow = 'escrow' as 'upfront';
    await expect(inflowAccepts(fakeSellerClient(), { price: '$1', paymentFlow })).rejects.toThrow(
      'paymentFlow must be authorization or upfront',
    );
  });
});

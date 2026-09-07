import { SCHEMES } from '@inflowpayai/x402';
import type { X402ConfigResponse, X402SupportedKind } from '@inflowpayai/x402';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import { describe, expect, it } from 'vitest';

import { inflowAccepts, inflowSchemeRegistrations } from '../../src/index.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';
import { UPTO_CONFIG, UPTO_KIND } from '../fixtures/upto-config.js';

describe('metered seller selection', () => {
  it('keeps exact and balance defaults when upto is advertised', async () => {
    const client = fakeSellerClient(UPTO_CONFIG);
    const accepts = await inflowAccepts(client, { price: '$0.10' });
    expect(accepts.map((entry) => entry.scheme)).toEqual(['exact', 'balance']);
    expect(accepts[0]?.extra).toMatchObject({ assetTransferMethod: 'eip3009' });
    expect(accepts[0]?.extra).not.toHaveProperty('permit2Proxy');
    const registrations = await inflowSchemeRegistrations(client);
    expect(registrations.map((entry) => entry.server.scheme)).toEqual(['exact', 'balance']);
  });

  it('selects a Permit2-capable EIP-3009 asset using upto metadata and the upstream server', async () => {
    const client = fakeSellerClient(UPTO_CONFIG);
    const schemes = [SCHEMES.UPTO];
    const accepts = await inflowAccepts(client, { price: '$0.10', schemes });
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      scheme: 'upto',
      network: UPTO_KIND.network,
      price: { amount: '100000' },
      extra: UPTO_KIND.extra,
    });
    const registrations = await inflowSchemeRegistrations(client, { schemes });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.server).toBeInstanceOf(UptoEvmScheme);
    expect(registrations[0]?.server.paymentFlows).toEqual({
      permit2: { supported: ['authorization'], default: 'authorization' },
    });
  });

  it('allows exact and upto together without changing the exact transfer method', async () => {
    const client = fakeSellerClient(UPTO_CONFIG);
    const schemes = ['exact', 'upto'];
    const accepts = await inflowAccepts(client, { price: '$0.10', schemes });
    expect(accepts.map((entry) => entry.scheme)).toEqual(schemes);
    expect(accepts.map((entry) => entry.extra?.['assetTransferMethod'])).toEqual(['eip3009', 'permit2']);
    expect((await inflowSchemeRegistrations(client, { schemes })).map((entry) => entry.server.scheme)).toEqual(schemes);
  });

  it('combines the scheme and network filters', async () => {
    expect(
      await inflowAccepts(fakeSellerClient(UPTO_CONFIG), {
        price: '$0.10',
        schemes: ['upto'],
        networks: ['eip155:1'],
      }),
    ).toEqual([]);
  });

  const invalidKinds: X402SupportedKind[] = [
    { ...UPTO_KIND, x402Version: 1 },
    { ...UPTO_KIND, scheme: 'exact' },
    { ...UPTO_KIND, network: 'eip155:1' },
    { ...UPTO_KIND, extra: {} },
    { ...UPTO_KIND, extra: { ...UPTO_KIND.extra, assetTransferMethod: 'eip3009' } },
    { ...UPTO_KIND, extra: { ...UPTO_KIND.extra, facilitatorAddress: 1 } },
    { ...UPTO_KIND, extra: { ...UPTO_KIND.extra, facilitatorAddress: '' } },
    { ...UPTO_KIND, extra: { ...UPTO_KIND.extra, permit2Proxy: 1 } },
    { ...UPTO_KIND, extra: { ...UPTO_KIND.extra, permit2Proxy: '' } },
  ];

  it.each(invalidKinds)('does not advertise or register an unusable supported kind: %j', async (kind) => {
    const client = fakeSellerClient({ ...UPTO_CONFIG, supported: [kind] });
    expect(await inflowAccepts(client, { price: '$0.10', schemes: ['upto'] })).toEqual([]);
    expect(await inflowSchemeRegistrations(client, { schemes: ['upto'] })).toEqual([]);
  });

  it.each(['no-permit2', 'non-evm'])('does not infer upto support for an ineligible asset: %s', async (reason) => {
    const config: X402ConfigResponse = {
      ...UPTO_CONFIG,
      assets: UPTO_CONFIG.assets.map((asset) => ({
        ...asset,
        permit2Proxy: reason === 'no-permit2' ? '' : '0xProxy',
        network: reason === 'non-evm' ? 'solana:devnet' : asset.network,
      })),
    };
    const client = fakeSellerClient(config);
    expect(await inflowAccepts(client, { price: '$0.10', schemes: ['upto'] })).toEqual([]);
    expect(await inflowSchemeRegistrations(client, { schemes: ['upto'] })).toEqual([]);
  });
});

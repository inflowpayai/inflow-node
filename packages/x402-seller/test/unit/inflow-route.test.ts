import { ASSET_TRANSFER_METHODS, CONTRACTS, type X402AssetInfo, type X402ConfigResponse } from '@inflowpayai/x402';
import {
  INFLOW_EIP7702_GAS_SPONSORING,
  declareInflowEip7702GasSponsoringExtension,
} from '@inflowpayai/x402/extensions';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, x402HTTPResourceServer, type HTTPAdapter } from '@x402/core/http';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { registerExactEvmScheme, type EvmClientConfig } from '@x402/evm/exact/client';
import { declareEip2612GasSponsoringExtension, EIP2612_GAS_SPONSORING } from '@x402/extensions';
import { describe, expect, it, vi } from 'vitest';

import { inflowAccepts } from '../../src/inflow-accepts.js';
import { inflowRoute, type InflowRouteOptions } from '../../src/inflow-route.js';
import { inflowSchemeRegistrations } from '../../src/scheme-registrations.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

function fixture(assetOverrides: Partial<X402AssetInfo> = {}) {
  const asset: X402AssetInfo = {
    assetTransferMethod: 'permit2',
    assetId: '0x1111111111111111111111111111111111111111',
    assetName: 'USDC',
    blockchain: 'BASE',
    currency: 'USDC',
    decimals: 6,
    network: 'eip155:8453',
    permit2Proxy: CONTRACTS.PERMIT2_PROXY,
    supportsEip2612: true,
    tokenName: 'USD Coin',
    tokenVersion: '2',
    ...assetOverrides,
  };
  const config: X402ConfigResponse = { ...structuredClone(SAMPLE_CONFIG), assets: [asset] };
  const supported = { ...SAMPLE_SUPPORTED, extensions: [EIP2612_GAS_SPONSORING.key] };
  const client = {
    ...fakeSellerClient(),
    config: () => Promise.resolve(config),
    refreshSupported: vi.fn(() => Promise.resolve(supported)),
  };
  return { asset, client, config, supported };
}

describe('inflowRoute', () => {
  function eip7702Fixture() {
    const f = fixture({ supportsEip2612: false, supportsEip7702: true });
    f.supported.extensions.push(INFLOW_EIP7702_GAS_SPONSORING);
    f.supported.kinds = [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: { supportsEip7702: true } }];
    return f;
  }

  it('declares EIP-7702 independently of token permit support and signing-domain metadata', async () => {
    const { client, asset } = eip7702Fixture();
    delete asset.tokenName;
    delete asset.tokenVersion;
    const route = await inflowRoute(client, { price: '$0.01' });
    expect(route.extensions).toEqual(declareInflowEip7702GasSponsoringExtension());
    expect(route.accepts).toHaveProperty('0.extra.supportsEip7702', true);
  });

  it.each(['asset', 'extension', 'kind', 'chain'] as const)(
    'does not infer EIP-7702 capability without matching %s support',
    async (missing) => {
      const { client, asset, supported } = eip7702Fixture();
      if (missing === 'asset') delete asset.supportsEip7702;
      if (missing === 'extension') supported.extensions = [];
      if (missing === 'kind') supported.kinds = [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }];
      if (missing === 'chain')
        supported.kinds = [{ x402Version: 2, scheme: 'exact', network: 'eip155:1', extra: { supportsEip7702: true } }];
      expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
    },
  );

  it('prefers standard EIP-2612 when both sponsorship methods are supported', async () => {
    const { client, asset } = eip7702Fixture();
    asset.supportsEip2612 = true;
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toEqual(declareEip2612GasSponsoringExtension());
  });

  it('uses the foundation declaration at route level for compatible Permit2 offers', async () => {
    const { client } = fixture();
    const route = await inflowRoute(client, { price: '$0.01' });
    expect(route.accepts).toEqual(await inflowAccepts(client, { price: '$0.01' }));
    expect(route.extensions).toEqual(declareEip2612GasSponsoringExtension());
    expect(route.accepts).toHaveProperty('0.extra.supportsEip2612', true);
    expect(client.refreshSupported).toHaveBeenCalledOnce();
  });

  it('does not change the default EIP-3009 offer or mutate cached config', async () => {
    const { client, config } = fixture({ assetTransferMethod: 'eip3009' });
    const before = structuredClone(config);
    const route = await inflowRoute(client, { price: '$0.01' });
    expect(route.extensions).toBeUndefined();
    expect(route.accepts).toEqual(await inflowAccepts(client, { price: '$0.01' }));
    expect(config).toEqual(before);
    expect(client.refreshSupported).not.toHaveBeenCalled();
  });

  it('selects Permit2 explicitly and registers it without advertising extra default offers', async () => {
    const { client, config } = fixture({ assetTransferMethod: 'eip3009' });
    const before = structuredClone(config);
    const route = await inflowRoute(client, { price: '$0.01', schemes: ['exact'], assetTransferMethod: 'permit2' });
    expect(route.extensions).toEqual(declareEip2612GasSponsoringExtension());
    expect(route.accepts).toHaveLength(1);
    expect(route.accepts).toHaveProperty('0.extra.assetTransferMethod', 'permit2');
    expect(route.accepts).toHaveProperty('0.extra.supportsEip2612', true);
    const registrations = await inflowSchemeRegistrations(client);
    expect(
      registrations.find((registration) => registration.network === 'eip155:8453')?.server.paymentFlows,
    ).toHaveProperty(ASSET_TRANSFER_METHODS.PERMIT2, { supported: ['authorization'], default: 'authorization' });
    expect(config).toEqual(before);
  });

  it.each([false, undefined])('does not infer token capability when supportsEip2612 is %s', async (capability) => {
    const { asset, client } = fixture();
    if (capability === undefined) delete asset.supportsEip2612;
    else asset.supportsEip2612 = capability;
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
    expect(client.refreshSupported).not.toHaveBeenCalled();
  });

  it.each([
    ['tokenName', undefined],
    ['tokenName', ''],
    ['tokenVersion', undefined],
    ['tokenVersion', ''],
    ['permit2Proxy', undefined],
    ['permit2Proxy', '0x2222222222222222222222222222222222222222'],
  ] as const)('omits sponsorship when %s is %s', async (key, value) => {
    const { asset, client } = fixture();
    if (value === undefined) delete asset[key];
    else asset[key] = value;
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
    expect(client.refreshSupported).not.toHaveBeenCalled();
  });

  it('accepts the canonical proxy in lowercase', async () => {
    const { client } = fixture({ permit2Proxy: CONTRACTS.PERMIT2_PROXY.toLowerCase() });
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toEqual(declareEip2612GasSponsoringExtension());
  });

  it('omits a global declaration when any Permit2 offer is incompatible', async () => {
    const { asset, client, config } = fixture();
    config.assets.push({
      ...asset,
      currency: 'USDT',
      assetId: '0x2222222222222222222222222222222222222222',
      supportsEip2612: false,
    });
    const route = await inflowRoute(client, { price: '$0.01', schemes: ['exact'] });
    expect(route.accepts).toHaveLength(2);
    expect(route.extensions).toBeUndefined();
    expect((await inflowRoute(client, { price: '0.01 USDC' })).extensions).toEqual(
      declareEip2612GasSponsoringExtension(),
    );
  });

  it.each([
    { networks: ['inflow:1'] },
    { schemes: ['balance'] },
    { networks: [] },
  ] satisfies Partial<InflowRouteOptions>[])('does not declare filtered-out sponsorship: %j', async (filter) => {
    const { client } = fixture();
    const route = await inflowRoute(client, {
      price: '$0.01',
      ...filter,
    });
    expect(route.extensions).toBeUndefined();
    expect(client.refreshSupported).not.toHaveBeenCalled();
  });

  it('does not convert assets lacking a configured canonical Permit2 proxy', async () => {
    const { client } = fixture({
      assetTransferMethod: 'eip3009',
      permit2Proxy: '0x2222222222222222222222222222222222222222',
    });
    const route = await inflowRoute(client, { price: '$0.01', assetTransferMethod: 'permit2', schemes: ['exact'] });
    expect(route).toEqual({ accepts: [] });
  });

  it('does not sponsor non-EVM Permit2 declarations', async () => {
    const { client } = fixture({ network: 'solana:test' });
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
    expect(
      (await inflowRoute(client, { price: '$0.01', assetTransferMethod: 'permit2', schemes: ['exact'] })).accepts,
    ).toEqual([]);
  });

  it('does not sponsor non-exact payment methods masquerading as Permit2', async () => {
    const { client, config } = fixture();
    config.paymentMethods[0] = {
      scheme: 'balance',
      network: 'inflow:1',
      payTo: config.sellerId,
      decimals: 18,
      extra: { assetTransferMethod: 'permit2' },
    };
    expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
  });

  it.each(['extension', 'network', 'scheme', 'version'] as const)(
    'requires facilitator %s support',
    async (missing) => {
      const { client, supported } = fixture();
      if (missing === 'extension') supported.extensions = [];
      else
        supported.kinds = [
          {
            network: missing === 'network' ? 'eip155:1' : 'eip155:8453',
            scheme: missing === 'scheme' ? 'balance' : 'exact',
            x402Version: missing === 'version' ? 1 : 2,
          },
        ];
      expect((await inflowRoute(client, { price: '$0.01' })).extensions).toBeUndefined();
    },
  );

  it('does not conceal a failed capability refresh', async () => {
    const { client } = fixture();
    client.refreshSupported.mockRejectedValue(new Error('facilitator unavailable'));
    await expect(inflowRoute(client, { price: '$0.01' })).rejects.toThrow('facilitator unavailable');
  });
});

const FOUNDATION_NETWORK = 'eip155:8453';
const FOUNDATION_BUYER = '0x2222222222222222222222222222222222222222';

async function foundationComposition(inflowFirst = true) {
  const { client, config, asset } = fixture({
    assetTransferMethod: 'eip3009',
    assetId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  });
  config.wallets = [{ address: FOUNDATION_BUYER, blockchain: asset.blockchain, network: FOUNDATION_NETWORK }];
  const route = await inflowRoute(client, {
    price: '0.01 USDC',
    schemes: ['exact'],
    networks: [FOUNDATION_NETWORK],
    assetTransferMethod: 'permit2',
  });
  const inflowVerify = vi.fn(() => Promise.resolve({ isValid: true, payer: FOUNDATION_BUYER }));
  const otherVerify = vi.fn(() => Promise.resolve({ isValid: true, payer: FOUNDATION_BUYER }));
  function facilitator(extensions: string[], verify: FacilitatorClient['verify']): FacilitatorClient {
    return {
      getSupported: () =>
        Promise.resolve({
          kinds: [{ x402Version: 2, scheme: 'exact', network: FOUNDATION_NETWORK }],
          extensions,
          signers: {},
        }),
      verify,
      settle: () => Promise.reject(new Error('settlement is outside this composition test')),
    };
  }
  const inflow = facilitator([EIP2612_GAS_SPONSORING.key], inflowVerify);
  const other = facilitator([], otherVerify);
  const resource = new x402ResourceServer(inflowFirst ? [inflow, other] : [other, inflow]);
  for (const registration of await inflowSchemeRegistrations(client)) {
    resource.register(registration.network, registration.server);
  }
  const http = new x402HTTPResourceServer(resource, { 'GET /sponsored': route });
  await http.initialize();
  const adapter: HTTPAdapter = {
    getHeader: () => undefined,
    getMethod: () => 'GET',
    getPath: () => '/sponsored',
    getUrl: () => 'https://example.com/sponsored',
    getAcceptHeader: () => 'application/json',
    getUserAgent: () => 'inflow-sponsorship-test',
  };
  const response = await http.processHTTPRequest({ adapter, path: '/sponsored', method: 'GET' });
  if (response.type !== 'payment-error') throw new Error('expected an unpaid response');
  const encoded = response.response.headers['PAYMENT-REQUIRED'];
  if (encoded === undefined) throw new Error('expected PAYMENT-REQUIRED header');
  return { required: decodePaymentRequiredHeader(encoded), resource, inflowVerify, otherVerify };
}

function foundationBuyer(allowance: bigint) {
  // Capture the real scheme's typed data; cryptographic signature verification is outside this test.
  const signTypedData = vi.fn<EvmClientConfig['signer']['signTypedData']>((): Promise<`0x${string}`> =>
    Promise.resolve<`0x${string}`>(`0x${'11'.repeat(64)}1b`),
  );
  const readContract = vi.fn<NonNullable<EvmClientConfig['signer']['readContract']>>(({ functionName }) => {
    if (functionName === 'allowance') return Promise.resolve(allowance);
    if (functionName === 'nonces') return Promise.resolve(7n);
    throw new Error(`unexpected contract read: ${functionName}`);
  });
  const buyer = new x402Client();
  registerExactEvmScheme(buyer, {
    networks: [FOUNDATION_NETWORK],
    signer: { address: FOUNDATION_BUYER, signTypedData, readContract },
  });
  return { buyer, signTypedData, readContract };
}

describe('inflowRoute with the foundation EVM client', () => {
  it('signs an exact-amount EIP-2612 permit from the actual 402 route declaration', async () => {
    const { required } = await foundationComposition();
    const { buyer, signTypedData, readContract } = foundationBuyer(0n);
    const payload = await buyer.createPaymentPayload(required);

    expect(signTypedData.mock.calls.map(([data]) => data.primaryType)).toEqual(['PermitWitnessTransferFrom', 'Permit']);
    expect(signTypedData.mock.calls[1]?.[0]).toMatchObject({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: required.accepts[0]?.asset },
      message: { owner: FOUNDATION_BUYER, spender: CONTRACTS.PERMIT2, value: 10000n, nonce: 7n },
    });
    expect(readContract.mock.calls.map(([args]) => args.functionName)).toEqual(['allowance', 'nonces']);
    expect(payload.extensions?.[EIP2612_GAS_SPONSORING.key]).toMatchObject({
      info: { from: FOUNDATION_BUYER, spender: CONTRACTS.PERMIT2, amount: '10000', nonce: '7' },
    });
    expect(payload.accepted.extra['assetTransferMethod']).toBe('permit2');
  });

  it('echoes only the declaration when sufficient allowance makes the extra permit unnecessary', async () => {
    const { required } = await foundationComposition();
    const { buyer, signTypedData, readContract } = foundationBuyer(10000n);
    const payload = await buyer.createPaymentPayload(required);

    expect(signTypedData.mock.calls.map(([data]) => data.primaryType)).toEqual(['PermitWitnessTransferFrom']);
    expect(readContract.mock.calls.map(([args]) => args.functionName)).toEqual(['allowance']);
    expect(payload.extensions?.[EIP2612_GAS_SPONSORING.key]).toEqual(
      declareEip2612GasSponsoringExtension()[EIP2612_GAS_SPONSORING.key],
    );
  });

  it.each([true, false])(
    'requires InFlow to win facilitator ordering for sponsorship: InFlow first = %s',
    async (inflowFirst) => {
      const { required, resource, inflowVerify, otherVerify } = await foundationComposition(inflowFirst);
      const { buyer } = foundationBuyer(0n);
      const payload = await buyer.createPaymentPayload(required);
      await resource.verifyPayment(payload, payload.accepted, required.extensions);

      expect(resource.getFacilitatorExtensions(2, FOUNDATION_NETWORK, 'exact')).toEqual(
        inflowFirst ? [EIP2612_GAS_SPONSORING.key] : [],
      );
      expect(required.extensions?.[EIP2612_GAS_SPONSORING.key]).toBeDefined();
      expect(inflowVerify).toHaveBeenCalledTimes(inflowFirst ? 1 : 0);
      expect(otherVerify).toHaveBeenCalledTimes(inflowFirst ? 0 : 1);
    },
  );
});

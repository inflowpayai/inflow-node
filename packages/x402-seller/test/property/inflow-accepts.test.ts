import * as fc from 'fast-check';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInflowSellerClient } from '../../src/seller-client.js';
import { inflowAccepts } from '../../src/inflow-accepts.js';
import { SAMPLE_SUPPORTED } from '../fixtures/config-response.js';
import type { PaymentMethodInfo, X402AssetInfo, X402ConfigResponse, X402WalletInfo } from '@inflowpayai/x402';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Deterministic identifier generators keep generated configs reproducible.
const evmAddressArb = fc.hexaString({ minLength: 40, maxLength: 40 }).map((s) => `0x${s}`);
const solanaAddressArb = fc.string({ minLength: 32, maxLength: 44 });

interface GeneratedShape {
  config: X402ConfigResponse;
  /** Expected on-chain entry count given the shape's permit2 mix. */
  expectedOnChainCount: number;
  /** Expected payment-method count after filtering out instrument methods. */
  expectedPaymentMethodCount: number;
}

function generateShape(rng: () => number): GeneratedShape {
  // Local helper: pull a value out of the rng-bridged fast-check sample call.
  void rng;
  throw new Error('unused — kept for type checker');
}

/**
 * Canonical x402ExactPermit2Proxy address (same on every supported EVM chain via CREATE2). Published on Permit2 assets
 * as a transparency aid for buyers — the facilitator still locks settlements to this address regardless of what the
 * seller advertises.
 */
const PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';

/**
 * Per-currency EVM transfer-method capabilities — mirrors the server's Currency.isEip3009 / Currency.isPermit2 emission
 * rules:
 *
 * - USDC, PYUSD: implement EIP-3009 in their token contract → method is `eip3009`.
 * - USDT: token contract does not implement `transferWithAuthorization` → method is `permit2`.
 */
function methodForCurrency(currency: 'USDC' | 'USDT' | 'PYUSD'): 'eip3009' | 'permit2' {
  return currency === 'USDT' ? 'permit2' : 'eip3009';
}

function evmAssetArb(blockchain: string, network: string): fc.Arbitrary<X402AssetInfo> {
  return fc
    .record({
      currency: fc.constantFrom(...(['USDC', 'USDT', 'PYUSD'] as const)),
      assetId: evmAddressArb,
    })
    .map(({ currency, assetId }) => {
      const method = methodForCurrency(currency);
      const asset: X402AssetInfo = {
        assetId,
        assetName: currency,
        blockchain,
        currency,
        decimals: 6,
        network,
        tokenName: `${currency} Token`,
        tokenVersion: '2',
        assetTransferMethod: method,
      };
      // Permit2 assets advertise the canonical proxy; EIP-3009 don't.
      if (method === 'permit2') asset.permit2Proxy = PERMIT2_PROXY;
      return asset;
    });
}

const evmWalletArb = (blockchain: string, network: string): fc.Arbitrary<X402WalletInfo> =>
  evmAddressArb.map((address) => ({ address, blockchain, network }));

const solanaWalletArb: fc.Arbitrary<X402WalletInfo> = fc
  .tuple(solanaAddressArb, solanaAddressArb)
  .map(([address, feePayer]) => ({
    address,
    blockchain: 'SOLANA',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    feePayer,
  }));

const solanaAssetArb: fc.Arbitrary<X402AssetInfo> = fc
  .record({
    assetId: solanaAddressArb,
    currency: fc.constantFrom('USDC', 'USDT'),
  })
  .map(({ assetId, currency }) => ({
    assetId,
    assetName: currency,
    blockchain: 'SOLANA',
    currency,
    decimals: 6,
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    tokenName: `${currency} Token`,
    tokenVersion: '1',
  }));

const balanceMethodArb: fc.Arbitrary<PaymentMethodInfo> = fc.constant({
  scheme: 'balance',
  network: 'inflow:1',
  payTo: '00000000-0000-0000-0000-000000000001',
  decimals: 18,
});

const configArb: fc.Arbitrary<X402ConfigResponse> = fc
  .record({
    baseWallets: fc.array(evmWalletArb('BASE', 'eip155:8453'), { minLength: 0, maxLength: 2 }),
    polygonWallets: fc.array(evmWalletArb('POLYGON', 'eip155:137'), { minLength: 0, maxLength: 2 }),
    solanaWallets: fc.array(solanaWalletArb, { minLength: 0, maxLength: 1 }),
    baseAssets: fc.array(evmAssetArb('BASE', 'eip155:8453'), { minLength: 0, maxLength: 2 }),
    polygonAssets: fc.array(evmAssetArb('POLYGON', 'eip155:137'), { minLength: 0, maxLength: 2 }),
    solanaAssets: fc.array(solanaAssetArb, { minLength: 0, maxLength: 1 }),
    includeBalance: fc.boolean(),
  })
  .map((parts) => {
    const wallets: X402WalletInfo[] = [...parts.baseWallets, ...parts.polygonWallets, ...parts.solanaWallets];
    const assets: X402AssetInfo[] = [...parts.baseAssets, ...parts.polygonAssets, ...parts.solanaAssets];
    const paymentMethods: PaymentMethodInfo[] = parts.includeBalance
      ? [
          {
            scheme: 'balance',
            network: 'inflow:1',
            payTo: '00000000-0000-0000-0000-000000000001',
            decimals: 18,
          },
        ]
      : [];
    return {
      sellerId: '00000000-0000-0000-0000-000000000001',
      supported: [],
      wallets,
      assets,
      paymentMethods,
    };
  });

void balanceMethodArb; // referenced for future shrink expansion
void generateShape;

/**
 * Expected on-chain entry count under the USD wildcard: Σ wallets[b] × Σ assets where blockchain=b
 *
 * One entry per (wallet, asset) — the server-published `assetTransferMethod` is used verbatim, no client-side fanout.
 * The canonical x402ExactPermit2Proxy is locked server-side and not advertised per-asset, so the SDK cannot synthesize
 * a Permit2 alternative from an EIP-3009 declaration.
 */
function expectedOnChainCount(config: X402ConfigResponse): number {
  const walletsByBlockchain: Record<string, number> = {};
  for (const w of config.wallets) {
    walletsByBlockchain[w.blockchain] = (walletsByBlockchain[w.blockchain] ?? 0) + 1;
  }
  let total = 0;
  for (const asset of config.assets) {
    const walletCount = walletsByBlockchain[asset.blockchain] ?? 0;
    total += walletCount;
  }
  return total;
}

describe('inflowAccepts property invariants', () => {
  it('on-chain entry count = Σ wallets[b] × Σ assets in b × methodsPerAsset(asset)', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, async (config) => {
        server.use(
          http.get(`${PROD_BASE}/v1/x402/config`, () => HttpResponse.json(config)),
          http.get(`${PROD_BASE}/v1/x402/supported`, () => HttpResponse.json(SAMPLE_SUPPORTED)),
        );
        const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
        const out = await inflowAccepts(client, { price: '$0.01' });
        const onChain = out.filter((o) => o.scheme === 'exact').length;
        const balance = out.filter((o) => o.scheme === 'balance').length;
        expect(onChain).toBe(expectedOnChainCount(config));
        // Balance: one entry per (paymentMethod, distinct asset currency).
        const distinctCurrencies = new Set(config.assets.map((a) => a.currency)).size;
        expect(balance).toBe(config.paymentMethods.length * distinctCurrencies);
        server.resetHandlers();
      }),
      { numRuns: 30 },
    );
  });

  it('Permit2 entries carry extra.permit2Proxy verbatim from the asset config; EIP-3009 entries omit it', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, async (config) => {
        server.use(
          http.get(`${PROD_BASE}/v1/x402/config`, () => HttpResponse.json(config)),
          http.get(`${PROD_BASE}/v1/x402/supported`, () => HttpResponse.json(SAMPLE_SUPPORTED)),
        );
        const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
        const out = await inflowAccepts(client, { price: '$0.01' });
        const evmExact = out.filter((o) => o.scheme === 'exact' && (o.network as string).startsWith('eip155:'));
        for (const entry of evmExact) {
          const extra = entry.extra as { assetTransferMethod?: string; permit2Proxy?: string };
          if (extra.assetTransferMethod === 'permit2') {
            // The server-published proxy address must reach the buyer's
            // extras unchanged — it's what they'll sign into the EIP-712
            // `spender` field.
            expect(extra.permit2Proxy).toBe(PERMIT2_PROXY);
          } else {
            expect(extra.permit2Proxy).toBeUndefined();
          }
        }
        server.resetHandlers();
      }),
      { numRuns: 30 },
    );
  });

  it('every entry carries an AssetAmount price (asset + amount strings)', async () => {
    await fc.assert(
      fc.asyncProperty(configArb, async (config) => {
        server.use(
          http.get(`${PROD_BASE}/v1/x402/config`, () => HttpResponse.json(config)),
          http.get(`${PROD_BASE}/v1/x402/supported`, () => HttpResponse.json(SAMPLE_SUPPORTED)),
        );
        const client = await createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
        const out = await inflowAccepts(client, { price: '$0.01' });
        for (const entry of out) {
          // vitest's `expect.any` matcher is typed `any` upstream; type-narrow + typeof checks read the same intent
          // (each price is an `AssetAmount`-shaped object with two string fields) without propagating `any`.
          const price = entry.price;
          expect(typeof price).toBe('object');
          expect(price).not.toBeNull();
          const obj = price as Record<string, unknown>;
          expect(typeof obj['asset']).toBe('string');
          expect(typeof obj['amount']).toBe('string');
        }
        server.resetHandlers();
      }),
      { numRuns: 30 },
    );
  });
});

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createInflowSellerClient } from '../../src/seller-client.js';
import { X402PriceParseError } from '../../src/errors.js';
import { inflowAccepts, toAtomicAmount } from '../../src/inflow-accepts.js';
import { SAMPLE_CONFIG, SAMPLE_SUPPORTED } from '../fixtures/config-response.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function installHandlers(configOverride?: typeof SAMPLE_CONFIG): void {
  server.use(
    http.get(`${PROD_BASE}/v1/x402/config`, () => HttpResponse.json(configOverride ?? SAMPLE_CONFIG)),
    http.get(`${PROD_BASE}/v1/x402/supported`, () => HttpResponse.json(SAMPLE_SUPPORTED)),
  );
}

async function makeClient(configOverride?: typeof SAMPLE_CONFIG) {
  installHandlers(configOverride);
  return createInflowSellerClient({ environment: 'production', apiKey: 'sk_test' });
}

describe('inflowAccepts', () => {
  it('emits one entry per (wallet, asset) with no filter', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });

    // SAMPLE_CONFIG (under USD wildcard):
    //   On-chain: USDC/Base (1 entry), USDT/Base (1 entry),
    //             USDC/Solana (1 entry) = 3 exact entries. The SDK takes
    //             `assetTransferMethod` from the server verbatim — no
    //             implicit EIP-3009/Permit2 fanout.
    //   Balance:  1 paymentMethod × 2 distinct asset currencies (USDC,
    //             USDT) = 2 balance entries.
    //   Total: 3 + 2 = 5.
    expect(out).toHaveLength(5);
    const schemes = out.map((o) => o.scheme);
    expect(schemes.filter((s) => s === 'exact')).toHaveLength(3);
    expect(schemes.filter((s) => s === 'balance')).toHaveLength(2);
  });

  it('emits AssetAmount price form (asset + atomic amount)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    for (const entry of out) {
      // vitest's `expect.any` matcher is typed `any` upstream; type-narrow + typeof checks read the same intent
      // (the price must be an `AssetAmount`-shaped object with two string fields) without propagating `any` into
      // the assertion site. `no-unsafe-assignment` would fire on `expect.any(String)`.
      const price = entry.price;
      expect(typeof price).toBe('object');
      expect(price).not.toBeNull();
      const obj = price as Record<string, unknown>;
      expect(typeof obj['asset']).toBe('string');
      expect(typeof obj['amount']).toBe('string');
    }
    // USDC on Base has decimals=6, so $0.01 → "10000".
    const usdcBase = out.find(
      (o) =>
        o.scheme === 'exact' &&
        o.network === 'eip155:8453' &&
        typeof o.price === 'object' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDC'),
    );
    expect(usdcBase).toBeDefined();
    expect((usdcBase!.price as { amount: string }).amount).toBe('10000');
  });

  it('emits one entry per asset, taking assetTransferMethod from the server config verbatim (no implicit fanout)', async () => {
    // The SDK doesn't synthesize a Permit2 alternative from an EIP-3009
    // declaration — whatever method the server publishes for an asset is
    // what we emit, exactly once.
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const usdcOnBase = out.filter(
      (o) =>
        o.scheme === 'exact' &&
        o.network === 'eip155:8453' &&
        typeof o.price === 'object' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDC'),
    );
    expect(usdcOnBase).toHaveLength(1);
    expect((usdcOnBase[0]!.extra as { assetTransferMethod: string }).assetTransferMethod).toBe('eip3009');
    // EIP-3009 entries don't carry permit2Proxy — the field is meaningful
    // only when the buyer is going to sign a Permit2 typed-data hash.
    expect((usdcOnBase[0]!.extra as { permit2Proxy?: string }).permit2Proxy).toBeUndefined();
  });

  it('Permit2 entries advertise the canonical permit2Proxy in extras', async () => {
    // The server publishes the canonical x402ExactPermit2Proxy address in
    // X402AssetInfo.permit2Proxy for Permit2 assets; inflowAccepts copies
    // it onto extra.permit2Proxy so the buyer can verify it before
    // signing the EIP-712 `spender` field. The address is locked to the
    // canonical on the facilitator side — advertising it here is a
    // transparency aid, not a buyer-overridable spender override.
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const usdt = out.filter(
      (o) =>
        o.scheme === 'exact' &&
        typeof o.price === 'object' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDT'),
    );
    expect(usdt).toHaveLength(1);
    const extra = usdt[0]!.extra as { assetTransferMethod: string; permit2Proxy?: string };
    expect(extra.assetTransferMethod).toBe('permit2');
    expect(extra.permit2Proxy).toBe('0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
  });

  it('emits feePayer on Solana entries', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const solana = out.find((o) => o.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(solana).toBeDefined();
    expect((solana!.extra as { feePayer: string }).feePayer).toBe('SoLaNaFeePayer0000000000000000000000000004');
  });

  it('emits one balance entry per stablecoin the seller advertises', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const balanceEntries = out.filter((o) => o.scheme === 'balance');
    // SAMPLE_CONFIG advertises USDC and USDT in `config.assets`.
    expect(balanceEntries.map((e) => (e.price as { asset: string }).asset).sort()).toEqual(['USDC', 'USDT']);
    for (const balance of balanceEntries) {
      expect(balance.network).toBe('inflow:1');
      expect(balance.payTo).toBe(SAMPLE_CONFIG.sellerId);
      // 18-decimal scale: $0.01 → "10000000000000000".
      expect((balance.price as { amount: string }).amount).toBe('10000000000000000');
    }
  });

  it('balance entries carry extra.assetName even when the server published no method extras', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const balanceEntries = out.filter((o) => o.scheme === 'balance');
    expect(balanceEntries.length).toBeGreaterThan(0);
    for (const balance of balanceEntries) {
      // `extra.assetName` is emitted uniformly across schemes so callers can
      // render the row's currency without branching on scheme. SAMPLE_CONFIG
      // does not publish any `paymentMethods[0].extra`, so `assetName` is
      // the only key.
      expect(balance.extra).toEqual({ assetName: (balance.price as { asset: string }).asset });
    }
  });

  it('balance entries merge method.extra with extra.assetName when the server publishes one', async () => {
    const override = {
      ...SAMPLE_CONFIG,
      paymentMethods: [
        {
          scheme: 'balance' as const,
          network: 'inflow:1',
          payTo: SAMPLE_CONFIG.sellerId,
          decimals: 18,
          extra: { customFlag: true, region: 'us-east' },
        },
      ],
    };
    const client = await makeClient(override);
    const out = await inflowAccepts(client, { price: '$0.01' });
    const balanceEntries = out.filter((o) => o.scheme === 'balance');
    for (const balance of balanceEntries) {
      expect(balance.extra).toEqual({
        customFlag: true,
        region: 'us-east',
        assetName: (balance.price as { asset: string }).asset,
      });
    }
  });

  it('every entry carries extra.assetName regardless of network', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    expect(out.length).toBeGreaterThan(0);
    for (const entry of out) {
      const extra = entry.extra as { assetName?: string } | undefined;
      expect(extra).toBeDefined();
      expect(typeof extra!.assetName).toBe('string');
      expect(extra!.assetName!.length).toBeGreaterThan(0);
    }
    // Spot-check the three on-chain rows: USDC/Base, USDT/Base, USDC/Solana.
    const usdcBase = out.find(
      (o) =>
        o.scheme === 'exact' &&
        o.network === 'eip155:8453' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDC'),
    );
    const usdtBase = out.find(
      (o) =>
        o.scheme === 'exact' &&
        o.network === 'eip155:8453' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDT'),
    );
    const usdcSol = out.find((o) => o.scheme === 'exact' && o.network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect((usdcBase!.extra as { assetName: string }).assetName).toBe('USDC');
    expect((usdtBase!.extra as { assetName: string }).assetName).toBe('USDT');
    expect((usdcSol!.extra as { assetName: string }).assetName).toBe('USDC');
  });

  it('balance entry honors an explicit PriceSpec currency', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: { amount: '0.5', currency: 'USDC' } });
    const balanceEntries = out.filter((o) => o.scheme === 'balance');
    expect(balanceEntries).toHaveLength(1);
    expect((balanceEntries[0]!.price as { asset: string }).asset).toBe('USDC');
  });

  it('default maxTimeoutSeconds is 300 per entry', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    for (const entry of out) {
      expect(entry.maxTimeoutSeconds).toBe(300);
    }
  });

  it('honors a custom maxTimeoutSeconds', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01', maxTimeoutSeconds: 120 });
    for (const entry of out) {
      expect(entry.maxTimeoutSeconds).toBe(120);
    }
  });

  it('filters by schemes (exact only)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01', schemes: ['exact'] });
    expect(out.every((o) => o.scheme === 'exact')).toBe(true);
    // SAMPLE_CONFIG has three on-chain assets: USDC/Base, USDT/Base,
    // USDC/Solana. One entry per (wallet, asset) pair — no implicit
    // EIP-3009/Permit2 fanout — so 3 exact entries total.
    expect(out).toHaveLength(3);
  });

  it('filters by schemes (balance only)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01', schemes: ['balance'] });
    // USD wildcard fans the single `balance` paymentMethod out across each
    // distinct currency in `config.assets` (USDC + USDT) — 2 entries.
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.scheme === 'balance')).toBe(true);
    expect(out.map((o) => (o.price as { asset: string }).asset).sort()).toEqual(['USDC', 'USDT']);
  });

  it('filters by networks (Base only)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01', networks: ['eip155:8453'] });
    expect(out.every((o) => o.network === 'eip155:8453')).toBe(true);
    // Two assets on Base (USDC + USDT), one entry per (wallet, asset).
    expect(out).toHaveLength(2);
  });

  it('filters by schemes AND networks (logical AND)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, {
      price: '$0.01',
      schemes: ['exact'],
      networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(out[0]!.scheme).toBe('exact');
  });

  it('returns [] when filters exclude everything', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01', networks: ['eip155:99999'] });
    expect(out).toEqual([]);
  });

  it('accepts $X price form (USD short)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.5' });
    const balance = out.find((o) => o.scheme === 'balance')!;
    // 18 decimals: $0.5 → "500000000000000000".
    expect((balance.price as { amount: string }).amount).toBe('500000000000000000');
  });

  it('accepts X CURRENCY price form (currency suffix)', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '0.01 USDC' });
    // USDC-only — USDT entry should be excluded.
    expect(out.some((o) => (o.price as { asset: string }).asset.startsWith('0xUSDT'))).toBe(false);
    const usdcs = out.filter((o) => o.scheme === 'exact');
    expect(usdcs.length).toBeGreaterThan(0);
  });

  it('accepts bare numeric price with currency field', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: { amount: '0.01', currency: 'USDC' } });
    expect(out.some((o) => (o.price as { asset: string }).asset.startsWith('0xUSDC'))).toBe(true);
    expect(out.some((o) => (o.price as { asset: string }).asset.startsWith('0xUSDT'))).toBe(false);
  });

  it('rejects bare numeric price without a currency field', async () => {
    const client = await makeClient();
    await expect(inflowAccepts(client, { price: '0.01' })).rejects.toBeInstanceOf(X402PriceParseError);
  });

  it('rejects unparseable price strings', async () => {
    const client = await makeClient();
    await expect(inflowAccepts(client, { price: 'cheap' })).rejects.toBeInstanceOf(X402PriceParseError);
  });

  it('passes any server-published scheme through unchanged (no allowlist gate)', async () => {
    const override = {
      ...SAMPLE_CONFIG,
      paymentMethods: [
        {
          scheme: 'instrument' as const,
          network: 'inflow:1',
          payTo: SAMPLE_CONFIG.sellerId,
          decimals: 18,
        },
      ],
    };
    const client = await makeClient(override);
    const out = await inflowAccepts(client, { price: '$0.01' });
    const instrumentEntries = out.filter((o) => o.scheme === 'instrument');
    expect(instrumentEntries.length).toBeGreaterThan(0);
    for (const entry of instrumentEntries) {
      expect(entry.network).toBe('inflow:1');
      expect(entry.payTo).toBe(SAMPLE_CONFIG.sellerId);
    }
  });

  it('USD wildcard matches every configured stablecoin', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const assets = new Set(out.filter((o) => o.scheme === 'exact').map((o) => (o.price as { asset: string }).asset));
    // Both USDC (Base + Solana) and USDT (Base) — three distinct assets.
    expect(assets.size).toBe(3);
  });

  it('ordering: on-chain entries in wallet declaration order, then payment methods', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    // Wallet declaration order: Base, Solana. One entry per (wallet, asset).
    // Then payment methods (one per distinct currency under USD wildcard).
    expect(out[0]!.network).toBe('eip155:8453'); // USDC eip3009
    expect(out[1]!.network).toBe('eip155:8453'); // USDT permit2
    expect(out[2]!.network).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'); // USDC solana
    expect(out[3]!.network).toBe('inflow:1');
    expect(out[4]!.network).toBe('inflow:1');
  });

  it('within an asset, the server-published assetTransferMethod is emitted verbatim', async () => {
    const client = await makeClient();
    const out = await inflowAccepts(client, { price: '$0.01' });
    const usdcOnBase = out.filter(
      (o) =>
        o.network === 'eip155:8453' &&
        typeof o.price === 'object' &&
        (o.price as { asset: string }).asset.startsWith('0xUSDC'),
    );
    // No more EIP-3009/Permit2 fanout — the SDK emits exactly what the
    // server's `assetTransferMethod` says. SAMPLE_CONFIG declares 'eip3009'
    // for USDC/Base, so we see one entry with that method.
    expect(usdcOnBase).toHaveLength(1);
    expect((usdcOnBase[0]!.extra as { assetTransferMethod: string }).assetTransferMethod).toBe('eip3009');
  });

  it('rejects price amounts that exceed the asset decimals (truncation)', async () => {
    const client = await makeClient();
    // 18-decimal balance + 6-decimal USDC: a 7-digit fractional component
    // is unrepresentable in USDC, so an entry construction would throw.
    await expect(inflowAccepts(client, { price: '$0.0000001' })).rejects.toBeInstanceOf(X402PriceParseError);
  });
});

describe('toAtomicAmount', () => {
  it('multiplies a decimal amount by 10**decimals using pure string math', () => {
    expect(toAtomicAmount('1.50', 6)).toBe('1500000');
    expect(toAtomicAmount('0.01', 6)).toBe('10000');
    expect(toAtomicAmount('1', 18)).toBe('1000000000000000000');
  });

  it('throws X402PriceParseError on unparseable input', () => {
    expect(() => toAtomicAmount('not-a-number', 6)).toThrow(X402PriceParseError);
  });

  it('throws X402PriceParseError when conversion would truncate a non-zero digit', () => {
    // 7 fractional digits cannot be represented in 6 decimals without truncation.
    expect(() => toAtomicAmount('0.0000001', 6)).toThrow(X402PriceParseError);
  });
});

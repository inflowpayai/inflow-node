import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { HTTPRequestContext, PaymentOption } from '@x402/core/http';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  createInflowFacilitator,
  createInflowResourceServer,
  createInflowHTTPResourceServer,
  inflowAccepts,
} from '../../src/index.js';
import type { InflowAcceptsOptions } from '../../src/index.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

async function fixture(
  price:
    | InflowAcceptsOptions['price']
    | ((context: HTTPRequestContext) => InflowAcceptsOptions['price'] | Promise<InflowAcceptsOptions['price']>),
  options: Partial<InflowAcceptsOptions> = {},
  configSource = SAMPLE_CONFIG,
  failure?: 'verify' | 'settle',
  select: (offers: PaymentOption[]) => PaymentOption[] = (offers) => offers,
) {
  const config = structuredClone(configSource);
  config.paymentMethods.push({ scheme: 'instrument', network: 'inflow:1', payTo: config.sellerId, decimals: 18 });
  const seller = fakeSellerClient(config);
  const events: string[] = [];
  const settled: PaymentRequirements[] = [];
  const app = express();
  app.use(express.json());
  app.get('/v1/x402/supported', (_request, response) =>
    response.json({
      kinds: [...config.supported, { x402Version: 2, scheme: 'instrument', network: 'inflow:1' }],
      extensions: [],
      signers: {},
    }),
  );
  app.post('/v1/x402/verify', (_request, response) => {
    events.push('verify');
    response.json({ isValid: failure !== 'verify', ...(failure === 'verify' ? { invalidReason: 'rejected' } : {}) });
  });
  app.post<Record<string, never>, unknown, { paymentRequirements: PaymentRequirements }>(
    '/v1/x402/settle',
    (request, response) => {
      events.push('settle');
      settled.push(request.body.paymentRequirements);
      response.json({
        success: failure !== 'settle',
        transaction: 'test-payment',
        network: request.body.paymentRequirements.network,
        ...(failure === 'settle' ? { errorReason: 'rejected' } : {}),
      });
    },
  );
  const makeRoute = async (resolvedPrice: InflowAcceptsOptions['price']) => ({
    settlementFailedResponseBody: () => ({ contentType: 'application/json', body: { rejectedPrice: resolvedPrice } }),
    accepts: select(
      await inflowAccepts(seller, {
        schemes: ['exact', 'balance'],
        networks: ['eip155:8453', 'inflow:1'],
        ...options,
        price: resolvedPrice,
      }),
    ),
  });
  const route =
    typeof price === 'function'
      ? async (context: HTTPRequestContext) => makeRoute(await price(context))
      : await makeRoute(price);
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  app.use(
    paymentMiddlewareFromHTTPServer(
      createInflowHTTPResourceServer(
        await createInflowResourceServer(seller, [
          createInflowFacilitator({ environment: 'sandbox', apiKey: 'test-key', baseUrl: origin }),
        ]),
        { 'POST /paid': route },
      ),
    ),
  );
  app.post('/paid', (_request, response) => {
    events.push('handler');
    response.json({ paid: true });
  });
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) =>
    response.status(500).json({ error: error.message }),
  );
  return {
    events,
    settled,
    config,
    request: (body: unknown = {}, accepted?: PaymentRequirements) =>
      fetch(`${origin}/paid`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          ...(accepted === undefined
            ? {}
            : {
                'payment-signature': encodePaymentSignatureHeader({
                  x402Version: 2,
                  accepted,
                  payload: {},
                } satisfies PaymentPayload),
              }),
        },
        signal: AbortSignal.timeout(5000),
      }),
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function requirements(response: Response) {
  expect(response.status).toBe(402);
  await response.arrayBuffer();
  const header = response.headers.get('payment-required');
  if (header === null) throw new Error('Missing payment challenge');
  return decodePaymentRequiredHeader(header).accepts;
}

describe('request pricing through foundation Express', () => {
  it('preserves reordered, duplicated, and interleaved concrete offers', async () => {
    const harness = await fixture(
      () => '0.10 USDC',
      {},
      SAMPLE_CONFIG,
      undefined,
      (offers) => {
        const [exact, balance] = offers;
        if (exact === undefined || balance === undefined) throw new Error('Missing offers');
        return [balance, { ...exact, maxTimeoutSeconds: 19 }, balance];
      },
    );
    try {
      const offers = await requirements(await harness.request());
      expect(offers.map((offer) => offer.scheme)).toEqual(['balance', 'exact', 'balance']);
      expect(offers.map((offer) => offer.maxTimeoutSeconds)).toEqual([300, 19, 300]);
    } finally {
      await harness.close();
    }
  });

  it('uses the request-specific response when after-handler settlement fails', async () => {
    const harness = await fixture(() => '0.10 USDC', { schemes: ['balance'] }, SAMPLE_CONFIG, 'settle');
    try {
      const [accepted] = await requirements(await harness.request());
      if (accepted === undefined) throw new Error('Missing offer');
      const response = await harness.request({}, accepted);
      expect(response.status).toBe(402);
      expect(await response.json()).toEqual({ rejectedPrice: '0.10 USDC' });
      expect(harness.events).toEqual(['verify', 'handler', 'settle']);
    } finally {
      await harness.close();
    }
  });

  it.each(['exact', 'balance'])('preserves an integrator selection of %s offers', async (scheme) => {
    const harness = await fixture(
      () => '0.10 USDC',
      {},
      SAMPLE_CONFIG,
      undefined,
      (offers) => offers.filter((offer) => offer.scheme === scheme),
    );
    try {
      const offers = await requirements(await harness.request());
      expect(offers.map((offer) => offer.scheme)).toEqual([scheme]);
    } finally {
      await harness.close();
    }
  });

  it('preserves integrator recipient, timeout, and extra changes', async () => {
    const harness = await fixture(
      () => '0.10 USDC',
      { schemes: ['balance'] },
      SAMPLE_CONFIG,
      undefined,
      (offers) =>
        offers.map((offer) => ({
          ...offer,
          payTo: 'selected-recipient',
          maxTimeoutSeconds: 17,
          extra: { ...offer.extra, selected: true },
        })),
    );
    try {
      const offers = await requirements(await harness.request());
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        payTo: 'selected-recipient',
        maxTimeoutSeconds: 17,
        extra: { selected: true },
      });
    } finally {
      await harness.close();
    }
  });

  it.each(['authorization', 'upfront'] as const)(
    'isolates concurrent prices and preserves %s order',
    async (paymentFlow) => {
      const seen: unknown[] = [];
      const harness = await fixture(
        async (context) => {
          const body = context.adapter.getBody?.() as { premium: boolean };
          seen.push(body);
          await setTimeout(body.premium ? 1 : 10);
          return { amount: body.premium ? '0.25' : '0.10', currency: body.premium ? 'USDT' : 'USDC' };
        },
        { paymentFlow },
      );
      try {
        expect(seen).toEqual([]);
        const [basic, premium] = await Promise.all([
          harness.request({ premium: false }).then(requirements),
          harness.request({ premium: true }).then(requirements),
        ]);
        expect(seen).toHaveLength(2);
        expect(basic).toHaveLength(2);
        expect(premium).toHaveLength(2);
        expect(basic[0]).toMatchObject({
          amount: '100000',
          extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
        });
        expect(premium[0]).toMatchObject({
          amount: '250000',
          extra: { name: 'Tether USD', version: '1', assetTransferMethod: 'permit2' },
        });
        expect(basic[1]).toMatchObject({ asset: 'USDC', amount: '100000000000000000' });
        expect(premium[1]).toMatchObject({ asset: 'USDT', amount: '250000000000000000' });
        expect(basic[0]?.extra['permit2Proxy']).toBeUndefined();
        expect(premium[0]?.extra['permit2Proxy']).toBeDefined();
        const accepted = premium[1];
        if (accepted === undefined) throw new Error('Missing balance offer');
        const wrong = await harness.request({ premium: false }, accepted);
        expect(wrong.status).toBe(402);
        await wrong.arrayBuffer();
        expect(harness.events).toEqual([]);
        const paid = await harness.request({ premium: true }, accepted);
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ paid: true });
        expect(harness.settled).toEqual([accepted]);
        expect(harness.events).toEqual(
          paymentFlow === 'upfront' ? ['settle', 'handler'] : ['verify', 'handler', 'settle'],
        );
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { amount: '0.25', currency: 'USDT' },
    '0.25 USDT',
    { asset: SAMPLE_CONFIG.assets[1]?.assetId ?? '', amount: '250000', extra: { custom: 'preserved' } },
  ])('resolves synchronous callback result %j', async (price) => {
    const harness = await fixture(() => price, { schemes: ['exact'], networks: ['eip155:8453'] });
    try {
      const offers = await requirements(await harness.request());
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        asset: SAMPLE_CONFIG.assets[1]?.assetId,
        amount: '250000',
        extra: { name: 'Tether USD' },
      });
      if (typeof price === 'object' && 'asset' in price) expect(offers[0]?.extra['custom']).toBe('preserved');
    } finally {
      await harness.close();
    }
  });

  it.each([0.25, '$0.25', '0.25 USD', '0.25 USDC', 1e-6])(
    'resolves money %j on Solana and retains the fee payer',
    async (price) => {
      const harness = await fixture(() => price, {
        schemes: ['exact'],
        networks: [SAMPLE_CONFIG.assets[2]?.network ?? ''],
      });
      try {
        const offers = await requirements(await harness.request());
        expect(offers[0]).toMatchObject({
          amount: price === 1e-6 ? '1' : '250000',
          asset: SAMPLE_CONFIG.assets[2]?.assetId,
          extra: { feePayer: SAMPLE_CONFIG.wallets[1]?.feePayer },
        });
      } finally {
        await harness.close();
      }
    },
  );

  it.each(['$0.50', { amount: '1', currency: 'USD' }, { asset: 'USD', amount: '500000000000000000' }])(
    'retains Instrument constraints for %j',
    async (price) => {
      const harness = await fixture(() => price, { schemes: ['instrument'] });
      try {
        const offers = await requirements(await harness.request());
        expect(offers[0]?.asset).toBe('USD');
        const paid = await harness.request({}, offers[0]);
        expect(paid.status).toBe(200);
        expect(await paid.json()).toEqual({ paid: true });
        expect(paid.headers.get('payment-response')).not.toBeNull();
        expect(harness.settled).toEqual(offers);
        expect(harness.events).toEqual(['verify', 'handler', 'settle']);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { price: () => '1 OTHER', options: { schemes: ['exact'] } },
    { price: () => ({ asset: 'unconfigured', amount: '1' }), options: {} },
    {
      price: () => {
        throw new Error('pricing failed');
      },
      options: {},
    },
    { price: () => Promise.reject(new Error('pricing failed')), options: {} },
    { price: () => '0.000000001 USDC', options: {} },
    ...['-1', '499999999999999999', '500000000000000001', '92233720368547758080000000000000000'].map((amount) => ({
      price: () => ({ asset: 'USD', amount }),
      options: { schemes: ['instrument'] },
    })),
  ])('does not run payment or application work when pricing fails: %j', async ({ price, options }) => {
    const harness = await fixture(price, options);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await harness.request();
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      expect(harness.events).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      logged.mockRestore();
      await harness.close();
    }
  });

  it('keeps caller-owned atomic prices unchanged', async () => {
    const result = { asset: SAMPLE_CONFIG.assets[0]?.assetId.toUpperCase() ?? '', amount: '250000' };
    const harness = await fixture(() => result, { schemes: ['exact'], networks: ['eip155:8453'] });
    try {
      const offers = await requirements(await harness.request());
      expect(offers[0]?.amount).toBe('250000');
      expect(result).toEqual({ asset: SAMPLE_CONFIG.assets[0]?.assetId.toUpperCase(), amount: '250000' });
    } finally {
      await harness.close();
    }
  });

  it.each(['$1', '0.25 USDT', { amount: '0.25', currency: 'USDC' }, '1 OTHER'])(
    'matches fixed pricing for %j across Base, Solana, balance, and Instrument',
    async (price) => {
      const config = structuredClone(SAMPLE_CONFIG);
      config.assets = config.assets.filter((asset) => asset.currency !== 'USDT');
      const solana = config.assets.find((asset) => asset.blockchain === 'SOLANA');
      if (solana === undefined) throw new Error('Missing Solana fixture');
      config.assets.push({ ...solana, currency: 'USDT', assetName: 'USDT', assetId: 'SolanaUsdtMint' });
      const options = {
        schemes: ['exact', 'balance', 'instrument'],
        networks: config.supported.map((kind) => kind.network),
      };
      const fixed = await fixture(price, options, config);
      const callback = vi.fn(() => price);
      const dynamic = await fixture(callback, options, config);
      try {
        expect(callback).not.toHaveBeenCalled();
        const expected = await requirements(await fixed.request());
        const actual = await requirements(await dynamic.request());
        expect(actual).toEqual(expected);
        expect(callback).toHaveBeenCalledTimes(1);
        if (price === '$1') expect(actual).toHaveLength(6);
        if (price === '0.25 USDT') {
          expect(actual).toHaveLength(2);
          expect(actual.some((offer) => offer.network === 'eip155:8453')).toBe(false);
        }
      } finally {
        await fixed.close();
        await dynamic.close();
      }
    },
  );

  it.each(['verify', 'settle'] as const)('does not release content on rejected %s', async (failure) => {
    const harness = await fixture(
      () => '$1',
      {
        schemes: ['instrument'],
        paymentFlow: failure === 'verify' ? 'authorization' : 'upfront',
      },
      SAMPLE_CONFIG,
      failure,
    );
    try {
      const [accepted] = await requirements(await harness.request());
      if (accepted === undefined) throw new Error('Missing Instrument offer');
      const response = await harness.request({}, accepted);
      expect(response.status).toBe(402);
      await response.arrayBuffer();
      expect(harness.events).toEqual([failure]);
    } finally {
      await harness.close();
    }
  });
});

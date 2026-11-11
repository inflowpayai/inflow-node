import type { HTTPRequestContext, PaymentOption } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { describe, expect, it, vi } from 'vitest';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

import {
  createInflowResourceServer,
  createInflowHTTPResourceServer,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '../../src/index.js';
import { SAMPLE_CONFIG } from '../fixtures/config-response.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

const context: HTTPRequestContext = {
  path: '/paid',
  method: 'GET',
  adapter: {
    getHeader: () => undefined,
    getMethod: () => 'GET',
    getPath: () => '/paid',
    getUrl: () => 'https://example.com/paid',
    getAcceptHeader: () => 'application/json',
    getUserAgent: () => 'test',
  },
};

function facilitator(kinds = SAMPLE_CONFIG.supported) {
  return {
    getSupported: vi.fn(() =>
      Promise.resolve({
        // Fixture network strings are CAIP-2 identifiers.
        kinds: kinds.map((kind) => ({ ...kind, network: kind.network as Network })),
        extensions: [],
        signers: {},
      }),
    ),
    verify: vi.fn(() => Promise.resolve({ isValid: true })),
    settle: vi.fn(() => Promise.resolve({ success: true, transaction: 'payment', network: 'inflow:1' as const })),
  } satisfies FacilitatorClient;
}

describe('request-priced resource server', () => {
  it('preserves native routing precedence, decoded paths, fixed routes, and unmatched requests', async () => {
    const server = await createInflowResourceServer(fakeSellerClient(), facilitator());
    const route = { accepts: await inflowAccepts(fakeSellerClient(), { price: '$1' }) };
    const plain = vi.fn(() => route);
    const encoded = vi.fn(() => route);
    const http = createInflowHTTPResourceServer(server, {
      'GET /paid/a': plain,
      'GET /paid/%61': encoded,
      'GET /fixed': route,
    });
    await http.initialize();
    const input = { ...context, path: '/paid/%61', decodedPath: '/paid/a' };
    expect(http.requiresPayment(input)).toBe(true);
    expect((await http.processHTTPRequest(input)).type).toBe('payment-error');
    expect(plain).toHaveBeenCalledOnce();
    expect(encoded).not.toHaveBeenCalled();
    expect(plain).toHaveBeenCalledWith(expect.objectContaining({ routePattern: '/paid/a' }));
    expect(
      (await http.processHTTPRequest({ ...context, path: '/paid/%61?query=1', decodedPath: '/paid/a?query=1' })).type,
    ).toBe('payment-error');
    expect((await http.processHTTPRequest({ ...context, path: '/fixed' })).type).toBe('payment-error');
    expect(await http.processHTTPRequest({ ...context, path: '/free' })).toEqual({ type: 'no-payment-required' });
    expect(await http.processHTTPRequest({ ...context, path: '/paid/a', method: 'POST' })).toEqual({
      type: 'no-payment-required',
    });
    expect(plain).toHaveBeenCalledTimes(2);
    expect(encoded).not.toHaveBeenCalled();
  });

  it('retains HTTP hooks, paywall rendering, and single-option route results', async () => {
    const server = await createInflowResourceServer(fakeSellerClient(), facilitator());
    const [offer] = await inflowAccepts(fakeSellerClient(), { price: '$1', schemes: ['balance'] });
    if (offer === undefined) throw new Error('Missing offer');
    const http = createInflowHTTPResourceServer(server, { 'GET /paid': () => ({ accepts: offer }) });
    const hook = vi.fn(() => Promise.resolve());
    const generateHtml = vi.fn(() => '<html>Pay here</html>');
    expect(http.onProtectedRequest(hook)).toBe(http);
    expect(http.registerPaywallProvider({ generateHtml })).toBe(http);
    await http.initialize();
    const input = {
      ...context,
      adapter: { ...context.adapter, getAcceptHeader: () => 'text/html', getUserAgent: () => 'Mozilla/5.0' },
    };
    expect(await http.processHTTPRequest(input)).toMatchObject({
      type: 'payment-error',
      response: { body: '<html>Pay here</html>', isHtml: true },
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(generateHtml).toHaveBeenCalledOnce();
    http.onProtectedRequest(() => Promise.resolve({ grantAccess: true }));
    expect(await http.processHTTPRequest(context)).toEqual({ type: 'no-payment-required' });
  });

  it('uses upstream Bazaar registration and enrichment for resolved declarations', async () => {
    const server = await createInflowResourceServer(fakeSellerClient(), facilitator());
    const accepts = await inflowAccepts(fakeSellerClient(), { price: '$1' });
    const extensions = declareDiscoveryExtension({ output: { example: { paid: true } } });
    const http = createInflowHTTPResourceServer(server, { 'GET /paid': () => ({ accepts, extensions }) });
    await http.initialize();
    expect(server.hasExtension('bazaar')).toBe(false);
    expect((await http.processHTTPRequest(context)).type).toBe('payment-error');
    expect(server.hasExtension('bazaar')).toBe(true);
    expect((await http.processHTTPRequest(context)).type).toBe('payment-error');
  });

  it('preserves ordinary upstream extension enrichment without mutating the declaration', async () => {
    const server = await createInflowResourceServer(fakeSellerClient(), facilitator());
    const enrich = vi.fn(() => ({ info: { url: context.adapter.getUrl() } }));
    server.registerExtension({ key: 'custom', enrichDeclaration: enrich });
    const declaration = { custom: { info: { original: true } } };
    const result = server.enrichExtensions(declaration, context);
    expect(result).toEqual({ custom: { info: { url: 'https://example.com/paid' } } });
    expect(enrich).toHaveBeenCalledWith(declaration.custom, context);
    expect(declaration).toEqual({ custom: { info: { original: true } } });
  });

  it('resolves independent helper groups once, preserving fixed options and foreign facilitator routing', async () => {
    const seller = fakeSellerClient();
    const inflow = facilitator();
    const external = facilitator([{ scheme: 'exact', network: 'eip155:1', x402Version: 2 }]);
    const server = await createInflowResourceServer(seller, [inflow, external]);
    const [registration] = await inflowSchemeRegistrations(seller, { schemes: ['exact'] });
    if (registration === undefined) throw new Error('Missing exact registration');
    server.register('eip155:1', registration.server);
    await server.initialize();
    const first = vi.fn(() => '$1');
    const second = vi.fn(() => '0.25 USDT');
    const foreignPrice = vi.fn(() => ({ asset: 'foreign-token', amount: '10' }));
    const foreignPayTo = vi.fn(() => 'foreign-seller');
    const fixed = await inflowAccepts(seller, { price: '0.10 USDC' });
    const options: PaymentOption[] = [
      ...(await inflowAccepts(seller, { price: first() })),
      ...fixed,
      { scheme: 'exact', network: 'eip155:1', price: foreignPrice, payTo: foreignPayTo },
      ...(await inflowAccepts(seller, { price: second() })),
    ];
    const before = JSON.stringify(options);
    const offers = await server.buildPaymentRequirementsFromOptions(options, context);
    expect(offers).toHaveLength(11);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(foreignPrice).toHaveBeenCalledWith(context);
    expect(foreignPayTo).toHaveBeenCalledWith(context);
    const foreign = offers.find((offer) => offer.network === 'eip155:1');
    if (foreign === undefined) throw new Error('Missing foreign offer');
    await server.verifyPayment({ x402Version: 2, accepted: foreign, payload: {} }, foreign);
    await server.settlePayment({ x402Version: 2, accepted: foreign, payload: {} }, foreign);
    expect(external.verify).toHaveBeenCalledTimes(1);
    expect(external.settle).toHaveBeenCalledTimes(1);
    expect(inflow.verify).not.toHaveBeenCalled();
    expect(inflow.settle).not.toHaveBeenCalled();
    expect(inflow.getSupported).toHaveBeenCalledTimes(1);
    expect(external.getSupported).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(options)).toBe(before);
  });

  it('rejects empty resolved routes without invoking the facilitator', async () => {
    const seller = fakeSellerClient();
    const provider = facilitator();
    const server = await createInflowResourceServer(seller, provider);
    const http = createInflowHTTPResourceServer(server, { 'GET /paid': () => ({ accepts: [] }) });
    await http.initialize();
    await expect(http.processHTTPRequest(context)).rejects.toThrow('No payment options');
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('retries failed initialization and shares successful initialization', async () => {
    const provider = facilitator();
    provider.getSupported.mockRejectedValueOnce(new Error('unavailable'));
    const server = await createInflowResourceServer(fakeSellerClient(), provider);
    const http = createInflowHTTPResourceServer(server, { 'GET /paid': () => ({ accepts: [] }) });
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(http.initialize()).rejects.toThrow('Failed to initialize');
      await Promise.all([http.initialize(), http.initialize()]);
      await http.initialize();
      expect(provider.getSupported).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps atomic-price metadata independent between requests and caller-owned objects', async () => {
    const seller = fakeSellerClient();
    const server = await createInflowResourceServer(seller, facilitator(), { schemes: ['balance'] });
    await server.initialize();
    const result = { asset: 'USDC', amount: '123', extra: { custom: { value: 'original' } } };
    const options = await inflowAccepts(seller, { price: result, schemes: ['balance'] });
    const [first] = await server.buildPaymentRequirementsFromOptions(options, context);
    if (first === undefined) throw new Error('Missing offer');
    (first.extra['custom'] as { value: string }).value = 'changed';
    const [second] = await server.buildPaymentRequirementsFromOptions(
      await inflowAccepts(seller, { price: result, schemes: ['balance'] }),
      context,
    );
    expect(second?.extra['custom']).toEqual({ value: 'original' });
    expect(result.extra.custom.value).toBe('original');
  });

  it('isolates nested configuration metadata between resolved requests', async () => {
    const config = structuredClone(SAMPLE_CONFIG);
    const [method] = config.paymentMethods;
    if (method === undefined) throw new Error('Missing balance method');
    method.extra = { custom: { value: 'original' } };
    const seller = fakeSellerClient(config);
    const server = await createInflowResourceServer(seller, facilitator());
    await server.initialize();
    const options = await inflowAccepts(seller, { price: '1 USDC', schemes: ['balance'] });
    const [first] = await server.buildPaymentRequirementsFromOptions(options, context);
    if (first === undefined) throw new Error('Missing offer');
    (first.extra['custom'] as { value: string }).value = 'changed';
    const [second] = await server.buildPaymentRequirementsFromOptions(
      await inflowAccepts(seller, { price: '1 USDC', schemes: ['balance'] }),
      context,
    );
    expect(second?.extra['custom']).toEqual({ value: 'original' });
    expect(method.extra).toEqual({ custom: { value: 'original' } });
  });
});

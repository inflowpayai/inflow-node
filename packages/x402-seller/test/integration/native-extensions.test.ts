import { once } from 'node:events';

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, type HTTPRequestContext } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402/extensions/bazaar';
import {
  createEIP712OfferReceiptIssuer,
  createOfferReceiptExtension,
  declareOfferReceiptExtension,
  extractOffersFromPaymentRequired,
  extractReceiptFromResponse,
  isEIP712SignedOffer,
  isEIP712SignedReceipt,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
} from '@x402/extensions/offer-receipt';
import {
  createSIWxPayload,
  createSIWxResourceServerExtension,
  declareSIWxExtension,
  encodeSIWxHeader,
  type SIWxExtension,
  type SIWxStorage,
} from '@x402/extensions/sign-in-with-x';
import { privateKeyToAccount } from 'viem/accounts';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createInflowHTTPResourceServer, createInflowResourceServer, inflowAccepts } from '../../src/index.js';
import { fakeSellerClient } from '../fixtures/seller-client.js';

const origin = 'https://seller.example';
const wallet = privateKeyToAccount(`0x${'01'.repeat(32)}`);

function request(path = '/reports/one', headers: Record<string, string> = {}): HTTPRequestContext {
  return {
    path,
    method: 'GET',
    adapter: {
      getHeader: (name) => headers[name.toLowerCase()],
      getMethod: () => 'GET',
      getPath: () => path,
      getUrl: () => `${origin}${path}`,
      getAcceptHeader: () => headers['accept'] ?? 'application/json',
      getUserAgent: () => headers['user-agent'] ?? 'test',
    },
  };
}

async function fixture(dynamic: boolean, upfront = false) {
  const paid = new Set<string>();
  const nonces = new Set<string>();
  const storage: SIWxStorage = {
    hasPaid: (path, address) => paid.has(`${path}:${address.toLowerCase()}`),
    recordPayment: (path, address) => {
      paid.add(`${path}:${address.toLowerCase()}`);
    },
    hasUsedNonce: (nonce) => nonces.has(nonce),
    recordNonce: (nonce) => {
      nonces.add(nonce);
    },
  };
  const facilitator = {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ scheme: 'exact', network: 'eip155:8453' as const, x402Version: 2 }],
        extensions: [],
        signers: {},
      }),
    verify: vi.fn(() => Promise.resolve({ isValid: true, payer: wallet.address })),
    settle: vi.fn(() =>
      Promise.resolve({
        success: true,
        network: 'eip155:8453' as const,
        transaction: 'synthetic',
        payer: wallet.address,
      }),
    ),
  } satisfies FacilitatorClient;
  const seller = fakeSellerClient();
  const server = await createInflowResourceServer(seller, facilitator);
  server.registerExtension(createSIWxResourceServerExtension({ origin, storage }));
  server.registerExtension(
    createOfferReceiptExtension(
      createEIP712OfferReceiptIssuer('did:web:seller.example#receipt', (data) => wallet.signTypedData(data)),
    ),
  );
  // Framework middleware registers Bazaar for fixed routes; this test calls the HTTP server directly.
  if (!dynamic) server.registerExtension(bazaarResourceServerExtension);
  const route = {
    accepts: await inflowAccepts(seller, {
      price: '1 USDC',
      networks: ['eip155:8453'],
      schemes: ['exact'],
      ...(upfront ? { paymentFlow: 'upfront' as const } : {}),
    }),
    extensions: {
      ...declareSIWxExtension({ expirationSeconds: 300 }),
      ...declareOfferReceiptExtension({ includeTxHash: true, offerValiditySeconds: 300 }),
      ...declareDiscoveryExtension({ output: { example: { report: 'ready' } } }),
    },
  };
  const http = createInflowHTTPResourceServer(server, { 'GET /reports/:id': dynamic ? () => route : route });
  await http.initialize();
  return { http, facilitator, storage, nonces, route };
}

async function challenge(http: Awaited<ReturnType<typeof fixture>>['http'], context = request()) {
  const result = await http.processHTTPRequest(context);
  if (result.type !== 'payment-error') throw new Error('Expected payment challenge');
  expect(result.response.status).toBe(402);
  const header = new Headers(result.response.headers).get('payment-required');
  if (header === null) throw new Error('Missing payment-required header');
  return decodePaymentRequiredHeader(header);
}

function siwx(required: Awaited<ReturnType<typeof challenge>>) {
  // The registered upstream SIWX extension owns this wire shape; assertions below verify its binding.
  const extension = required.extensions?.['sign-in-with-x'] as SIWxExtension;
  expect(extension.info.domain).toBe('seller.example');
  expect(extension.info.uri).toBe(`${origin}/reports/one`);
  const chain = extension.supportedChains[0];
  if (chain === undefined) throw new Error('Missing SIWX chain');
  return { ...extension.info, ...chain };
}

describe.each([false, true])('native seller extensions with dynamic routes=%s', (dynamic) => {
  it('renders the native EVM paywall only for browser requests without initiating payment', async () => {
    const harness = await fixture(dynamic);
    harness.http.registerPaywallProvider(
      createPaywall().withNetwork(evmPaywall).withConfig({ appName: 'Example reports', testnet: false }).build(),
    );
    const browser = await harness.http.processHTTPRequest(
      request('/reports/one', { accept: 'text/html', 'user-agent': 'Mozilla/5.0' }),
    );
    if (browser.type !== 'payment-error') throw new Error('Expected unpaid browser response');
    expect(browser.response.status).toBe(402);
    expect(new Headers(browser.response.headers).get('content-type')).toContain('text/html');
    expect(browser.response.body).toContain('window.x402');
    expect(browser.response.body).toContain('Example reports');
    await challenge(harness.http);
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
  });

  it('retains a valid signed settlement receipt when the upfront handler fails', async () => {
    const harness = await fixture(dynamic, true);
    const app = express();
    app.use(paymentMiddlewareFromHTTPServer(harness.http));
    let handlerCalls = 0;
    app.get('/reports/:id', (_request, response) => {
      expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
      handlerCalls += 1;
      response.status(500).json({ error: 'Report generation failed' });
    });
    const listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    try {
      const address = listener.address();
      if (address === null || typeof address === 'string') throw new Error('Missing listener address');
      const url = `http://127.0.0.1:${address.port.toString()}/reports/one`;
      const initial = await fetch(url);
      await initial.arrayBuffer();
      const header = initial.headers.get('payment-required');
      if (header === null) throw new Error('Missing payment challenge');
      const required = decodePaymentRequiredHeader(header);
      const accepted = required.accepts[0];
      if (accepted === undefined) throw new Error('Missing offer');
      const response = await fetch(url, {
        headers: {
          'payment-signature': encodePaymentSignatureHeader({
            x402Version: 2,
            accepted,
            resource: required.resource,
            payload: {},
          }),
        },
      });
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      const receipt = extractReceiptFromResponse(response);
      if (receipt === undefined || !isEIP712SignedReceipt(receipt)) throw new Error('Missing signed receipt');
      const verified = await verifyReceiptSignatureEIP712(receipt);
      expect(verified.signer.toLowerCase()).toBe(wallet.address.toLowerCase());
      expect(verified.payload).toMatchObject({ payer: wallet.address, transaction: 'synthetic' });
      expect(handlerCalls).toBe(1);
      expect(harness.facilitator.verify).not.toHaveBeenCalled();
      expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('enriches independent Bazaar requests without mutating the declaration', async () => {
    const harness = await fixture(dynamic);
    const before = JSON.stringify(harness.route.extensions);
    const responses = await Promise.all([
      challenge(harness.http, request('/reports/one')),
      challenge(harness.http, request('/reports/two')),
    ]);
    for (const [index, response] of responses.entries()) {
      expect(response.extensions?.['bazaar']).toMatchObject({
        routeTemplate: '/reports/:id',
        info: { input: { method: 'GET', pathParams: { id: index === 0 ? 'one' : 'two' } } },
      });
    }
    expect(JSON.stringify(harness.route.extensions)).toBe(before);
    expect(harness.facilitator.verify).not.toHaveBeenCalled();
    expect(harness.facilitator.settle).not.toHaveBeenCalled();
  });

  it('records settled access, verifies a real wallet signature, and rejects nonce replay', async () => {
    const harness = await fixture(dynamic);
    const required = await challenge(harness.http);
    const offer = extractOffersFromPaymentRequired(required)[0];
    if (offer === undefined || !isEIP712SignedOffer(offer)) throw new Error('Missing signed offer');
    const signedOffer = await verifyOfferSignatureEIP712(offer);
    expect(signedOffer.signer.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(signedOffer.payload).toMatchObject({ resourceUrl: `${origin}/reports/one`, network: 'eip155:8453' });
    const accepted = required.accepts[0];
    if (accepted === undefined) throw new Error('Missing payment offer');
    const context = request('/reports/one', {
      'payment-signature': encodePaymentSignatureHeader({
        x402Version: 2,
        accepted,
        resource: required.resource,
        payload: {},
      }),
    });
    const verified = await harness.http.processHTTPRequest(context);
    if (verified.type !== 'payment-verified') throw new Error('Expected verified payment');
    const settled = await harness.http.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
      { request: context },
    );
    expect(settled.success).toBe(true);
    const receipt = extractReceiptFromResponse(new Response(null, { headers: settled.headers }));
    if (receipt === undefined || !isEIP712SignedReceipt(receipt)) throw new Error('Missing signed receipt');
    const signedReceipt = await verifyReceiptSignatureEIP712(receipt);
    expect(signedReceipt.signer.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(signedReceipt.payload).toMatchObject({
      resourceUrl: `${origin}/reports/one`,
      payer: wallet.address,
      transaction: 'synthetic',
    });
    expect(await harness.storage.hasPaid('/reports/one', wallet.address)).toBe(true);
    const proof = await createSIWxPayload(siwx(await challenge(harness.http)), wallet, `${origin}/reports/one`);
    const headers = { 'sign-in-with-x': encodeSIWxHeader(proof) };
    expect(await harness.http.processHTTPRequest(request('/reports/one', headers))).toEqual({
      type: 'no-payment-required',
    });
    expect(harness.nonces.size).toBe(1);
    await challenge(harness.http, request('/reports/one', headers));
    expect(harness.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(harness.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it.each(['unpaid', 'wrong-origin', 'expired', 'bad-signature'] as const)(
    'does not grant access for %s',
    async (failure) => {
      const harness = await fixture(dynamic);
      if (failure !== 'unpaid') await harness.storage.recordPayment('/reports/one', wallet.address);
      const info = siwx(await challenge(harness.http));
      const proof = await createSIWxPayload(info, wallet, `${origin}/reports/one`);
      const invalid =
        failure === 'wrong-origin'
          ? { ...proof, domain: 'attacker.example' }
          : failure === 'expired'
            ? { ...proof, expirationTime: '2000-01-01T00:00:00.000Z' }
            : failure === 'bad-signature'
              ? { ...proof, signature: '0x00' }
              : proof;
      await challenge(harness.http, request('/reports/one', { 'sign-in-with-x': encodeSIWxHeader(invalid) }));
      expect(harness.nonces.size).toBe(0);
      expect(harness.facilitator.verify).not.toHaveBeenCalled();
      expect(harness.facilitator.settle).not.toHaveBeenCalled();
    },
  );

  it('does not issue a signed receipt or record access when settlement fails', async () => {
    const harness = await fixture(dynamic);
    harness.facilitator.settle.mockResolvedValueOnce({
      success: false,
      network: 'eip155:8453',
      transaction: '',
      payer: wallet.address,
    });
    const required = await challenge(harness.http);
    const accepted = required.accepts[0];
    if (accepted === undefined) throw new Error('Missing payment offer');
    const context = request('/reports/one', {
      'payment-signature': encodePaymentSignatureHeader({
        x402Version: 2,
        accepted,
        resource: required.resource,
        payload: {},
      }),
    });
    const verified = await harness.http.processHTTPRequest(context);
    if (verified.type !== 'payment-verified') throw new Error('Expected verified payment');
    const settled = await harness.http.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
      { request: context },
    );
    expect(settled.success).toBe(false);
    expect(extractReceiptFromResponse(new Response(null, { headers: settled.headers }))).toBeUndefined();
    expect(await harness.storage.hasPaid('/reports/one', wallet.address)).toBe(false);
  });
});

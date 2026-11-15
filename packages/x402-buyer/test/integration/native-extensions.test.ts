import { x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader, type HTTPRequestContext } from '@x402/core/http';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  BuilderCodeClientExtension,
  BuilderCodeFacilitatorExtension,
  declareBuilderCodeExtension,
  parseBuilderCodeSuffixFromCalldata,
} from '@x402/extensions/builder-code';
import {
  createSIWxClientExtension,
  createSIWxResourceServerExtension,
  declareSIWxExtension,
  InMemorySIWxStorage,
} from '@x402/extensions/sign-in-with-x';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createInflowClient } from '../../src/index.js';

const wallet = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const origin = 'https://seller.example';
const service = setupServer();
beforeAll(() => service.listen({ onUnhandledRequest: 'error' }));
afterEach(() => service.resetHandlers());
afterAll(() => service.close());

function request(headers: Record<string, string> = {}): HTTPRequestContext {
  return {
    path: '/report',
    method: 'GET',
    adapter: {
      getHeader: (name) => headers[name.toLowerCase()],
      getMethod: () => 'GET',
      getPath: () => '/report',
      getUrl: () => `${origin}/report`,
      getAcceptHeader: () => 'application/json',
      getUserAgent: () => 'test',
    },
  };
}

async function buyer() {
  service.use(
    http.get('https://api.inflowpay.ai/v1/transactions/x402-supported', () => HttpResponse.json({ kinds: [] })),
  );
  const client = await createInflowClient({ apiKey: 'synthetic' });
  registerExactEvmScheme(client, { signer: wallet, networks: ['eip155:8453'] });
  return client;
}

async function seller() {
  const storage = new InMemorySIWxStorage();
  const core = new x402ResourceServer({
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }],
        extensions: [],
        signers: {},
      }),
    verify: () => Promise.reject(new Error('Authentication must not verify a payment')),
    settle: () => Promise.reject(new Error('Authentication must not settle a payment')),
  });
  core.register('eip155:8453', new ExactEvmScheme());
  core.registerExtension(createSIWxResourceServerExtension({ origin, storage }));
  const server = new x402HTTPResourceServer(core, {
    'GET /report': {
      accepts: { scheme: 'exact', network: 'eip155:8453', price: '$1', payTo: wallet.address },
      extensions: declareSIWxExtension({ expirationSeconds: 300 }),
    },
  });
  await server.initialize();
  const response = await server.processHTTPRequest(request());
  if (response.type !== 'payment-error') throw new Error('Missing challenge');
  const header = new Headers(response.response.headers).get('payment-required');
  if (header === null) throw new Error('Missing payment-required');
  return { server, storage, required: decodePaymentRequiredHeader(header) };
}

describe('native buyer extensions through InflowClient', () => {
  it('uses the native SIWX HTTP hook and wallet signer to access a previously paid resource without a payment', async () => {
    const client = await buyer();
    const harness = await seller();
    harness.storage.recordPayment('/report', wallet.address);
    const createPayment = vi.spyOn(client, 'createPaymentPayload');
    client.registerExtension(createSIWxClientExtension({ signers: [wallet] }));
    const transport = new x402HTTPClient(client);
    const headers = await transport.handlePaymentRequired(harness.required, `${origin}/report`);
    expect(headers).not.toBeNull();
    expect(await harness.server.processHTTPRequest(request(headers ?? {}))).toEqual({ type: 'no-payment-required' });
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('does not sign a challenge for another origin or implicitly pay when authentication is unavailable', async () => {
    const client = await buyer();
    const harness = await seller();
    const signMessage = vi.fn(wallet.signMessage);
    client.registerExtension(createSIWxClientExtension({ signers: [{ ...wallet, signMessage }] }));
    const transport = new x402HTTPClient(client);
    expect(await transport.handlePaymentRequired(harness.required, 'https://other.example/report')).toBeNull();
    expect(signMessage).not.toHaveBeenCalled();
    const headers = await transport.handlePaymentRequired(harness.required, `${origin}/report`);
    expect((await harness.server.processHTTPRequest(request(headers ?? {}))).type).toBe('payment-error');
    client.registerPolicy(() => []);
    await expect(transport.createPaymentPayload(harness.required)).rejects.toThrow('filtered');
  });

  it('composes explicit builder codes with native external-wallet signing and facilitator suffix generation', async () => {
    const client = await buyer();
    const { required } = await seller();
    const declaration = declareBuilderCodeExtension('seller_app', ['seller_service']);
    const paymentRequired: PaymentRequired = { ...required, extensions: { 'builder-code': declaration } };
    const before = structuredClone(paymentRequired);
    client.registerExtension(new BuilderCodeClientExtension('buyer_service'));
    const payload = await client.createPaymentPayload(paymentRequired);
    expect(payload.extensions?.['builder-code']).toMatchObject({
      info: { a: 'seller_app', s: ['buyer_service', 'seller_service'] },
    });
    const facilitator = new BuilderCodeFacilitatorExtension({
      builderCode: 'facilitator_wallet',
      serviceCode: 'facilitator_service',
    });
    const suffix = facilitator.buildDataSuffix({ paymentPayload: payload, paymentRequirements: payload.accepted });
    if (suffix === undefined) throw new Error('Missing attribution suffix');
    expect(parseBuilderCodeSuffixFromCalldata(suffix)).toMatchObject({
      a: 'seller_app',
      w: 'facilitator_wallet',
      s: ['buyer_service', 'seller_service', 'facilitator_service'],
    });
    expect(paymentRequired).toEqual(before);
    const plain = await (await buyer()).createPaymentPayload({ ...required, extensions: {} });
    expect(plain.extensions?.['builder-code']).toBeUndefined();
  });
});

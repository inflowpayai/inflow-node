import { x402Client } from '@x402/core/client';
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import {
  BuilderCodeClientExtension,
  BuilderCodeFacilitatorExtension,
  declareBuilderCodeExtension,
  parseBuilderCodeSuffixFromCalldata,
} from '@x402/extensions/builder-code';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { createInflowClient, InflowClient, type EncodedPayment } from '../../src/index.js';
import { toFoundationPayload } from '../../src/_foundation-bridge.js';
import { createInflowSigner } from '../../src/signer.js';

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
const wallet = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const requirement = {
  scheme: 'exact',
  network: 'eip155:8453' as const,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: wallet.address,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
};

async function setup(declared = true, onCreate?: (required: PaymentRequired) => void) {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: 'https://seller.example/report' },
    accepts: [structuredClone(requirement)],
    ...(declared
      ? { extensions: { 'builder-code': declareBuilderCodeExtension('seller_app', ['seller_service', 'shared']) } }
      : {}),
  };
  const signing = new x402Client();
  registerExactEvmScheme(signing, { signer: wallet, networks: ['eip155:8453'] });
  // Only platform HTTP is substituted. The authorization and attribution use the installed upstream implementations.
  const signed = await signing.createPaymentPayload({ ...required, extensions: {} });
  signed.extensions = {
    'payment-identifier': { info: { id: 'payment_1234567890', required: false } },
    unrelated: { value: 'keep' },
  };
  const creates = vi.fn<(body: unknown) => void>();
  const polls = vi.fn();
  const cancels = vi.fn();
  let canonical = structuredClone(signed);
  api.use(
    http.get('https://api.inflowpay.ai/v1/transactions/x402-supported', () =>
      HttpResponse.json({ kinds: [{ scheme: 'exact', network: requirement.network, x402Version: 2 }] }),
    ),
    http.post('https://api.inflowpay.ai/v1/transactions/x402', async ({ request }) => {
      const body: unknown = await request.json();
      creates(body);
      canonical = structuredClone(signed);
      if (
        body !== null &&
        typeof body === 'object' &&
        'extensions' in body &&
        body.extensions !== null &&
        typeof body.extensions === 'object'
      ) {
        canonical.extensions = { ...canonical.extensions, ...body['extensions'] };
      }
      onCreate?.(required);
      return HttpResponse.json({ transactionId: 'tx_test', approvalId: 'apr_test', approvalStatus: 'APPROVED' });
    }),
    http.get('https://api.inflowpay.ai/v1/transactions/tx_test/x402', () => {
      polls();
      return HttpResponse.json({
        status: 'SETTLED',
        encodedPayload: encodePaymentSignatureHeader(canonical),
        paymentPayload: canonical,
      });
    }),
    http.post('https://api.inflowpay.ai/v1/approvals/apr_test/cancel', () => {
      cancels();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const client = await createInflowClient({ apiKey: 'synthetic', prefer: ['exact'] });
  return { client, required, signed, creates, polls, cancels };
}

it.each(['one-shot', 'prepared'] as const)(
  'composes native attribution without changing the signed authorization: %s',
  async (mode) => {
    const { client, required, signed, creates, polls } = await setup();
    const original = structuredClone(required);
    const extension = new BuilderCodeClientExtension(['buyer_service', 'shared']);
    const enrich = vi.spyOn(extension, 'enrichPaymentPayload');
    client.registerExtension(extension);
    const after = vi.fn();
    client.onAfterPaymentCreation(after);
    const prepared = mode === 'prepared' ? await client.prepareInflowPayment(requirement, required) : undefined;
    const result =
      prepared === undefined
        ? await client.createPaymentPayload(required)
        : toFoundationPayload((await prepared.awaitPayload()).paymentPayload);
    expect(result.payload).toEqual(signed.payload);
    expect(result.accepted).toEqual(signed.accepted);
    expect(result.extensions?.['payment-identifier']).toEqual(signed.extensions?.['payment-identifier']);
    expect(result.extensions?.['unrelated']).toEqual({ value: 'keep' });
    expect(result.extensions?.['builder-code']).toMatchObject({
      info: { a: 'seller_app', s: ['buyer_service', 'shared', 'seller_service'] },
    });
    expect(required).toEqual(original);
    expect(signed.extensions?.['builder-code']).toBeUndefined();
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ paymentPayload: result }));
    if (prepared !== undefined) {
      const [first, second] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
      expect(first).toBe(second);
      expect(first.transactionId).toBe('tx_test');
      expect(decodePaymentSignatureHeader(first.encodedPayload)).toEqual(result);
    }
    expect(enrich).toHaveBeenCalledOnce();
    expect(creates).toHaveBeenCalledOnce();
    expect(polls).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    const suffix = new BuilderCodeFacilitatorExtension({ builderCode: 'facilitator_wallet' }).buildDataSuffix({
      paymentPayload: result,
      paymentRequirements: requirement,
    });
    if (suffix === undefined) throw new Error('Missing attribution suffix');
    expect(parseBuilderCodeSuffixFromCalldata(`0x1234${suffix}`)).toEqual({
      a: 'seller_app',
      s: ['buyer_service', 'shared', 'seller_service'],
      w: 'facilitator_wallet',
    });
  },
);

it('preserves seller attribution without a registered buyer code', async () => {
  const { client, required } = await setup();
  const payload = await client.createPaymentPayload(required);
  expect(payload.extensions?.['builder-code']).toEqual(required.extensions?.['builder-code']);
});

it('allows an explicitly registered buyer code without a seller declaration', async () => {
  const { client, required } = await setup(false);
  client.registerExtension(new BuilderCodeClientExtension('buyer_service'));
  expect((await client.createPaymentPayload(required)).extensions?.['builder-code']).toEqual({
    info: { s: ['buyer_service'] },
  });
});

it('does not inject attribution or re-encode payments when neither side configures it', async () => {
  const { client, required, signed } = await setup(false);
  const prepared = await client.prepareInflowPayment(requirement, required);
  const result = await prepared.awaitPayload();
  expect(result.paymentPayload).toEqual(signed);
  expect(result.encodedPayload).toBe(encodePaymentSignatureHeader(signed));
});

it('isolates seller declarations captured by a prepared payment', async () => {
  const { client, required } = await setup();
  const prepared = await client.prepareInflowPayment(requirement, required);
  required.extensions = { 'builder-code': declareBuilderCodeExtension('changed') };
  expect((await prepared.awaitPayload()).paymentPayload.extensions?.['builder-code']).toMatchObject({
    info: { a: 'seller_app' },
  });
});

it('does not run unrelated payment enrichment or overwrite server-owned extensions', async () => {
  const { client, required, signed } = await setup();
  required.extensions = {
    ...required.extensions,
    unrelated: { value: 'seller' },
    'payment-identifier': { info: { id: 'other' } },
  };
  const enrich = vi.fn();
  client.registerExtension({ key: 'unrelated', enrichPaymentPayload: enrich });
  expect((await client.createPaymentPayload(required)).extensions?.['payment-identifier']).toEqual(
    signed.extensions?.['payment-identifier'],
  );
  expect(enrich).not.toHaveBeenCalled();
});

it('rejects enrichment failure before creating an approval', async () => {
  const { client, required, creates, polls } = await setup();
  const error = new Error('Attribution failed');
  const enrich = vi.fn(() => Promise.reject(error));
  client.registerExtension({ key: 'builder-code', enrichPaymentPayload: enrich });
  const after = vi.fn();
  client.onAfterPaymentCreation(after);
  await expect(client.prepareInflowPayment(requirement, required)).rejects.toBe(error);
  expect(enrich).toHaveBeenCalledOnce();
  expect(creates).not.toHaveBeenCalled();
  expect(polls).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it('routes one-shot enrichment errors through the existing failure hooks', async () => {
  const { client, required } = await setup();
  const error = new Error('Attribution failed');
  client.registerExtension({ key: 'builder-code', enrichPaymentPayload: () => Promise.reject(error) });
  const failure = vi.fn();
  client.onPaymentCreationFailure(failure);
  await expect(client.createPaymentPayload(required)).rejects.toBe(error);
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ error }));
});

it('completes attribution before creating an approval and shares concurrent payload retrieval', async () => {
  const { client, required, creates, polls, cancels } = await setup();
  let start = () => {};
  let finish = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const native = new BuilderCodeClientExtension('buyer_service');
  const enrich = vi.fn(
    async (payload: Parameters<typeof native.enrichPaymentPayload>[0], declaration: PaymentRequired) => {
      start();
      await released;
      return native.enrichPaymentPayload(payload, declaration);
    },
  );
  client.registerExtension({ key: 'builder-code', enrichPaymentPayload: enrich });
  const after = vi.fn();
  client.onAfterPaymentCreation(after);
  const preparing = client.prepareInflowPayment(requirement, required);
  await started;
  expect(creates).not.toHaveBeenCalled();
  finish();
  const prepared = await preparing;
  const [first, second] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
  expect(first).toBe(second);
  expect(enrich).toHaveBeenCalledOnce();
  expect(creates).toHaveBeenCalledOnce();
  expect(polls).toHaveBeenCalledOnce();
  expect(cancels).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledOnce();
});

it('keeps prepared attribution and its encoded header intact when a completion observer mutates its copy', async () => {
  const { client, required } = await setup();
  client.registerExtension(new BuilderCodeClientExtension('buyer_service'));
  client.onAfterPaymentCreation(({ paymentPayload }) => {
    paymentPayload.extensions = {};
    return Promise.resolve();
  });
  const prepared = await client.prepareInflowPayment(requirement, required);
  const [first, second] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
  expect(first).toBe(second);
  expect(first.paymentPayload.extensions?.['builder-code']).toMatchObject({
    info: { a: 'seller_app', s: ['buyer_service', 'seller_service', 'shared'] },
  });
  expect(decodePaymentSignatureHeader(first.encodedPayload)).toEqual(first.paymentPayload);
});

it('preserves seller codes when the registered extension only has lifecycle hooks', async () => {
  const { client, required } = await setup();
  const hook = vi.fn();
  client.registerExtension({ key: 'builder-code', hooks: { onAfterPaymentCreation: hook } });
  expect((await client.createPaymentPayload(required)).extensions?.['builder-code']).toEqual(
    required.extensions?.['builder-code'],
  );
  expect(hook).toHaveBeenCalledOnce();
});

it('keeps the original one-shot declaration while signing is in flight', async () => {
  const { client, required } = await setup(true, (declaration) => {
    declaration.extensions = { 'builder-code': declareBuilderCodeExtension('changed') };
  });
  expect((await client.createPaymentPayload(required)).extensions?.['builder-code']).toMatchObject({
    info: { a: 'seller_app' },
  });
});

it('rejects a signed result that arrives after cancellation without repeating enrichment', async () => {
  const { required, signed, creates, cancels } = await setup();
  const signer = await createInflowSigner({ apiKey: 'synthetic' });
  const serverPrepared = await signer.prepare(requirement, required);
  let finish: (value: EncodedPayment) => void = () => {};
  const response = new Promise<EncodedPayment>((resolve) => {
    finish = resolve;
  });
  // Hold only the completed response to exercise cancellation racing with delivery, not signing or attribution.
  vi.spyOn(signer, 'prepare').mockResolvedValue({ ...serverPrepared, awaitPayload: () => response });
  const client = new InflowClient(signer);
  const extension = new BuilderCodeClientExtension('buyer_service');
  const enrich = vi.spyOn(extension, 'enrichPaymentPayload');
  client.registerExtension(extension);
  const prepared = await client.prepareInflowPayment(requirement, required);
  const rejected = expect(prepared.awaitPayload()).rejects.toThrow('cancelled');
  await prepared.cancel();
  finish({ transactionId: 'tx_test', paymentPayload: signed, encodedPayload: encodePaymentSignatureHeader(signed) });
  await rejected;
  expect(enrich).toHaveBeenCalledOnce();
  expect(creates).toHaveBeenCalledOnce();
  expect(cancels).toHaveBeenCalledOnce();
});

it('sends attribution before approval and retrieves identical bytes from a fresh client', async () => {
  const { client, required, creates } = await setup();
  client.registerExtension(new BuilderCodeClientExtension('inflow'));
  const prepared = await client.prepareInflowPayment(requirement, required);
  expect(creates.mock.calls[0]?.[0]).toMatchObject({
    extensions: {
      'builder-code': { info: { a: 'seller_app', s: ['inflow', 'seller_service', 'shared'] } },
    },
  });
  const first = await prepared.awaitPayload();
  const fresh = await createInflowClient({ apiKey: 'synthetic', prefer: ['exact'] });
  const resumed = await fresh.getX402Payload(prepared.transactionId);
  expect(resumed.encodedPayload).toBe(first.encodedPayload);
  expect(resumed.paymentPayload).toEqual(first.paymentPayload);
  expect(creates).toHaveBeenCalledOnce();
});

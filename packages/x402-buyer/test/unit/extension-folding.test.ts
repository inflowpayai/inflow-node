import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';
import { PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createInflowClient } from '../../src/inflow-client.js';

const PROD_BASE = 'https://api.inflowpay.ai';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SUPPORTED = {
  kinds: [
    { scheme: 'balance' as const, network: 'inflow:1', x402Version: 2 },
    { scheme: 'exact' as const, network: 'eip155:8453', x402Version: 2 },
  ],
};

function installSupported(): void {
  server.use(http.get(`${PROD_BASE}/v1/transactions/x402-supported`, () => HttpResponse.json(SUPPORTED)));
}

// Foundation-signed branch only — the override delegates to
// super.createPaymentPayload for non-InFlow networks. Use an EVM
// requirement to force that branch.
const EVM_REQ: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:1',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  amount: '10000',
  payTo: '0xseller',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
};

function paymentRequired(extensions?: Record<string, unknown>): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://example.com/api/widgets', description: 'demo' },
    accepts: [EVM_REQ] as unknown as PaymentRequired['accepts'],
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

function baseFoundationPayload(): PaymentPayload {
  return {
    x402Version: 2,
    accepted: EVM_REQ as unknown as PaymentPayload['accepted'],
    payload: { authorization: { from: '0xa', to: '0xb' }, signature: '0xsig' },
  };
}

describe('InflowClient.createPaymentPayload — foundation-branch extension folding', () => {
  it('passes payload through unchanged when no extensions are declared', async () => {
    installSupported();
    const foundationPayload = baseFoundationPayload();
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(paymentRequired())) as unknown as InflowPaymentPayload;
      expect(result).toEqual(foundationPayload);
      expect(result.extensions).toBeUndefined();
    } finally {
      superSpy.mockRestore();
    }
  });

  it('passes payload through unchanged when the only declared extension is unhandled', async () => {
    installSupported();
    const foundationPayload = baseFoundationPayload();
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      // 'unknown-extension' is not in EXTENSION_REGISTRY — the fold loop
      // iterates registered handlers only, so nothing happens for an
      // unhandled name. The payload passes through.
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(
        paymentRequired({ 'unknown-extension': { required: false } }),
      )) as unknown as InflowPaymentPayload;
      expect(result).toEqual(foundationPayload);
    } finally {
      superSpy.mockRestore();
    }
  });

  it('skips an optional declared extension when the handler returns null', async () => {
    installSupported();
    const foundationPayload = baseFoundationPayload();
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      // payment-identifier with `required: false` and no providedPaymentId
      // → handler returns null → fold skips, payload passes through.
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(
        paymentRequired({ 'payment-identifier': { required: false } }),
      )) as unknown as InflowPaymentPayload;
      expect(result.extensions).toBeUndefined();
    } finally {
      superSpy.mockRestore();
    }
  });

  it('throws when a required extension cannot be satisfied by the registered handler', async () => {
    installSupported();
    const foundationPayload = baseFoundationPayload();
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      const client = await createInflowClient({ apiKey: 'sk_test' });
      await expect(
        client.createPaymentPayload(paymentRequired({ 'payment-identifier': { required: true } })),
      ).rejects.toThrow(/payment-identifier.*required.*no payload entry/u);
    } finally {
      superSpy.mockRestore();
    }
  });

  it('preserves an existing extensions map and ignores undeclared registry handlers', async () => {
    installSupported();
    // The foundation client may have already attached its own
    // extension data (e.g. an EIP-2612 permit) — the fold must not
    // wipe that out, and undeclared registry handlers must not be
    // invoked.
    const foundationPayload: PaymentPayload = {
      ...baseFoundationPayload(),
      extensions: { 'eip2612-gas-sponsoring': { sponsorSignature: '0xabc' } },
    };
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(
        paymentRequired(), // no InFlow-registered extensions declared
      )) as unknown as InflowPaymentPayload;
      expect(result.extensions).toEqual({
        'eip2612-gas-sponsoring': { sponsorSignature: '0xabc' },
      });
    } finally {
      superSpy.mockRestore();
    }
  });

  it('folds a non-null handler entry into the returned payload.extensions', async () => {
    installSupported();
    const foundationPayload = baseFoundationPayload();
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    // The override builds an empty SignContext, so the default
    // payment-identifier handler always returns null in production.
    // Spy on the handler so it returns a non-null entry; this
    // exercises the entry-fold branch and the merge-return path.
    const handlerSpy = vi
      .spyOn(PAYMENT_IDENTIFIER, 'buildPayloadEntry')
      .mockReturnValue({ paymentId: 'pay_spyfoldedvalue1234567890' });
    try {
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(
        paymentRequired({ 'payment-identifier': { required: false } }),
      )) as unknown as InflowPaymentPayload;
      expect(result.extensions).toEqual({
        'payment-identifier': { paymentId: 'pay_spyfoldedvalue1234567890' },
      });
      // Pre-existing payload fields are preserved verbatim.
      expect(result.payload).toEqual(foundationPayload.payload);
      expect(result.accepted).toEqual(foundationPayload.accepted);
    } finally {
      handlerSpy.mockRestore();
      superSpy.mockRestore();
    }
  });

  it('merges a folded entry alongside pre-existing foundation extensions', async () => {
    installSupported();
    const foundationPayload: PaymentPayload = {
      ...baseFoundationPayload(),
      extensions: { 'eip2612-gas-sponsoring': { sponsorSignature: '0xabc' } },
    };
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    const handlerSpy = vi
      .spyOn(PAYMENT_IDENTIFIER, 'buildPayloadEntry')
      .mockReturnValue({ paymentId: 'pay_spyfoldedvalue1234567890' });
    try {
      const client = await createInflowClient({ apiKey: 'sk_test' });
      const result = (await client.createPaymentPayload(
        paymentRequired({ 'payment-identifier': { required: false } }),
      )) as unknown as InflowPaymentPayload;
      expect(result.extensions).toEqual({
        'eip2612-gas-sponsoring': { sponsorSignature: '0xabc' },
        'payment-identifier': { paymentId: 'pay_spyfoldedvalue1234567890' },
      });
    } finally {
      handlerSpy.mockRestore();
      superSpy.mockRestore();
    }
  });

  it('does not fold InFlow extensions on the InFlow-signed branch (server already handled them)', async () => {
    installSupported();
    // Force an InFlow-supported requirement so the override stays on the
    // InFlow branch; the InFlow server is the one that built the
    // extensions map, so the fold logic must not run again.
    const inflowReq: PaymentRequirements = {
      scheme: 'balance',
      network: 'inflow:1',
      asset: '',
      amount: '1000',
      payTo: '00000000-0000-0000-0000-000000000001',
      maxTimeoutSeconds: 300,
      extra: {},
    };
    const inflowPayload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: inflowReq,
      payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
      // The InFlow server-signed branch returns extensions verbatim from
      // the server. A required declaration on the seller side must NOT
      // cause the override to second-guess the server's response.
      extensions: { 'payment-identifier': { paymentId: 'pay_serverissuedabc123' } },
    };
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({
          approvalId: 'apr_1',
          approvalStatus: 'APPROVED',
          transactionId: 'tx_1',
        }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx_1/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: 'unused',
          paymentPayload: inflowPayload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const result = (await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: 'https://example.com/api/widgets', description: 'demo' },
      accepts: [inflowReq] as unknown as PaymentRequired['accepts'],
      extensions: { 'payment-identifier': { required: true } },
    })) as unknown as InflowPaymentPayload;
    expect(result.extensions).toEqual({
      'payment-identifier': { paymentId: 'pay_serverissuedabc123' },
    });
  });
});

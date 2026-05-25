import { Buffer } from 'node:buffer';

import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';
import { x402Client, type ClientExtension, type PaymentPolicy } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, SchemeNetworkClient } from '@x402/core/types';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { X402AdapterRoutingError, X402ApprovalFailedError } from '../../src/errors.js';
import { createInflowClient, InflowClient } from '../../src/inflow-client.js';

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

const INFLOW_REQ: PaymentRequirements = {
  scheme: 'balance',
  network: 'inflow:1',
  asset: '',
  amount: '1000',
  payTo: '00000000-0000-0000-0000-000000000001',
  maxTimeoutSeconds: 300,
  extra: {},
};

const EVM_REQ: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:1',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  amount: '10000',
  payTo: '0x0000000000000000000000000000000000000abc',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
};

function makeInflowPayload(): InflowPaymentPayload {
  return {
    x402Version: 2,
    accepted: INFLOW_REQ,
    payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
  };
}

function encodedFor(payload: InflowPaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function paymentRequired(
  accepts: readonly PaymentRequirements[],
  extensions?: Record<string, unknown>,
): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://example.com/api/widgets', description: 'List' },
    accepts: accepts as unknown as PaymentRequired['accepts'],
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

describe('createInflowClient — construction', () => {
  it('primes the buyer capability cache before resolving', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/x402-supported`, () => {
        calls += 1;
        return HttpResponse.json(SUPPORTED);
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    expect(calls).toBe(1);
    expect(client).toBeInstanceOf(InflowClient);
  });

  it('accepts InflowBearerClientOptions and threads the token into the prime call', async () => {
    let captured: Headers | undefined;
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/x402-supported`, ({ request }) => {
        captured = request.headers;
        return HttpResponse.json(SUPPORTED);
      }),
    );
    const getAccessToken = vi.fn(() => Promise.resolve('bearer-prime-token'));
    const client = await createInflowClient({ getAccessToken });
    expect(client).toBeInstanceOf(InflowClient);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(captured?.get('authorization')).toBe('Bearer bearer-prime-token');
    expect(captured?.get('x-api-key')).toBeNull();
  });
});

describe('InflowClient.createPaymentPayload — InFlow branch', () => {
  it('routes a supported requirement through the InFlow signer and returns the parsed paymentPayload', async () => {
    installSupported();
    const payload = makeInflowPayload();
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
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const result = (await client.createPaymentPayload(
      paymentRequired([INFLOW_REQ]),
    )) as unknown as InflowPaymentPayload;
    expect(result).toEqual(payload);
  });

  it('honors prefer order when multiple InFlow-supported requirements are offered', async () => {
    installSupported();
    const exactReq: PaymentRequirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    };
    let captured: { accept?: PaymentRequirements } | undefined;
    const payload = makeInflowPayload();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, async ({ request }) => {
        captured = (await request.json()) as { accept: PaymentRequirements };
        return HttpResponse.json({
          approvalId: 'apr_1',
          approvalStatus: 'APPROVED',
          transactionId: 'tx_1',
        });
      }),
      http.get(`${PROD_BASE}/v1/transactions/tx_1/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        }),
      ),
    );
    // Default prefer is ['balance', 'exact']: even though `exact` is
    // listed first in accepts, the balance entry should win.
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await client.createPaymentPayload(paymentRequired([exactReq, INFLOW_REQ]));
    expect(captured?.accept).toEqual(INFLOW_REQ);
  });

  it('fires the server-side cancel when the InFlow await loop throws', async () => {
    installSupported();
    let cancels = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => HttpResponse.json({ status: 'DECLINED' })),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () => {
        cancels += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.createPaymentPayload(paymentRequired([INFLOW_REQ]))).rejects.toBeInstanceOf(
      X402ApprovalFailedError,
    );
    // Cancel is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 50));
    expect(cancels).toBe(1);
  });

  it('does not call super.createPaymentPayload when InFlow handles the requirement', async () => {
    installSupported();
    const payload = makeInflowPayload();
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
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue({} as PaymentPayload);
    try {
      await client.createPaymentPayload(paymentRequired([INFLOW_REQ]));
      expect(superSpy).not.toHaveBeenCalled();
    } finally {
      superSpy.mockRestore();
    }
  });
});

describe('InflowClient.createPaymentPayload — foundation delegate branch', () => {
  it('delegates to super.createPaymentPayload when no accepts entry is InFlow-supported', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const foundationPayload: PaymentPayload = {
      x402Version: 2,
      accepted: EVM_REQ as unknown as PaymentPayload['accepted'],
      payload: { authorization: { from: '0xa', to: '0xb' }, signature: '0xsig' },
    };
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      const result = await client.createPaymentPayload(paymentRequired([EVM_REQ]));
      expect(superSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(foundationPayload);
    } finally {
      superSpy.mockRestore();
    }
  });

  it('lets the foundation error surface unchanged when nothing is registered', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    // No schemes registered on the InflowClient → foundation's
    // selector throws because no requirement matches a registered
    // (scheme, network).
    await expect(client.createPaymentPayload(paymentRequired([EVM_REQ]))).rejects.toThrow();
  });

  it('folds payment-identifier into the foundation-signed payload when the seller declares it', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const foundationPayload: PaymentPayload = {
      x402Version: 2,
      accepted: EVM_REQ as unknown as PaymentPayload['accepted'],
      payload: { authorization: { from: '0xa', to: '0xb' }, signature: '0xsig' },
    };
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      // The default payment-identifier handler returns null when no
      // providedPaymentId is in the SignContext — fold is a no-op for
      // optional declarations without a provided id. The result must
      // still pass through unchanged.
      const result = await client.createPaymentPayload(
        paymentRequired([EVM_REQ], { 'payment-identifier': { required: false } }),
      );
      expect(result).toEqual(foundationPayload);
    } finally {
      superSpy.mockRestore();
    }
  });

  it('throws when a required extension cannot be satisfied by any registered handler', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const foundationPayload: PaymentPayload = {
      x402Version: 2,
      accepted: EVM_REQ as unknown as PaymentPayload['accepted'],
      payload: {},
    };
    const superSpy = vi.spyOn(x402Client.prototype, 'createPaymentPayload').mockResolvedValue(foundationPayload);
    try {
      await expect(
        client.createPaymentPayload(paymentRequired([EVM_REQ], { 'payment-identifier': { required: true } })),
      ).rejects.toThrow(/payment-identifier.*required.*no payload entry/u);
    } finally {
      superSpy.mockRestore();
    }
  });
});

describe('InflowClient.prepareInflowPayment', () => {
  it('forwards a supported requirement to the InFlow signer prepare flow', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({
          approvalId: 'apr_1',
          approvalStatus: 'PENDING',
          transactionId: 'tx_1',
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, {
      resource: { url: 'https://example.com/api/widgets', description: 'List' },
      x402Version: 2,
    });
    expect(prepared.approvalId).toBe('apr_1');
    expect(prepared.transactionId).toBe('tx_1');
  });

  it('throws X402AdapterRoutingError when InFlow does not cover the (scheme, network)', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(
      client.prepareInflowPayment(EVM_REQ, {
        resource: { url: 'https://example.com/api/widgets', description: 'List' },
        x402Version: 2,
      }),
    ).rejects.toBeInstanceOf(X402AdapterRoutingError);
  });
});

describe('InflowClient — chainable foundation methods', () => {
  it('register, registerV1, registerPolicy, registerExtension, and the 4 hooks all return this for chaining', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });

    // Minimal stubs satisfying the foundation contracts. The
    // overrides delegate to super and return `this`; the test only
    // cares that the return value preserves the InflowClient
    // subclass identity through the chain.
    const schemeStub: SchemeNetworkClient = {
      scheme: 'test',
      createPaymentPayload: () => Promise.resolve({ x402Version: 2, payload: {} }),
    };
    const policyStub: PaymentPolicy = (_v, reqs) => reqs;
    const extensionStub: ClientExtension = { key: 'test-ext' };
    const noopHook = (): Promise<void> => Promise.resolve();

    const chained = client
      .register('eip155:1', schemeStub)
      .registerV1('base-sepolia', schemeStub)
      .registerPolicy(policyStub)
      .registerExtension(extensionStub)
      .onBeforePaymentCreation(noopHook)
      .onAfterPaymentCreation(noopHook)
      .onPaymentCreationFailure(noopHook)
      .onPaymentResponse(noopHook);

    expect(chained).toBe(client);
    expect(chained).toBeInstanceOf(InflowClient);
  });
});

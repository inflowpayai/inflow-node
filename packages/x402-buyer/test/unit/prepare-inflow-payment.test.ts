import { Buffer } from 'node:buffer';

import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  X402AdapterRoutingError,
  X402ApprovalCancelledError,
  X402ApprovalFailedError,
  X402ApprovalTimeoutError,
  X402PaymentIdFormatError,
} from '../../src/errors.js';
import { createInflowClient } from '../../src/inflow-client.js';
import type { SigningContext } from '../../src/types.js';

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

const REQUIREMENT: PaymentRequirements = {
  scheme: 'balance',
  network: 'inflow:1',
  asset: '',
  amount: '1000000000000000000',
  payTo: '00000000-0000-0000-0000-000000000001',
  maxTimeoutSeconds: 300,
  extra: {},
};

const CONTEXT: SigningContext = {
  resource: { url: 'https://example.com/api/widgets', description: 'List' },
  x402Version: 2,
};

function makePayload(): InflowPaymentPayload {
  return {
    x402Version: 2,
    accepted: REQUIREMENT,
    payload: { transactionId: '00000000-0000-0000-0000-000000000abc' },
  };
}

function encodedFor(payload: InflowPaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

describe('InflowClient.prepareInflowPayment — handle construction', () => {
  it('POSTs accept + resource + x402Version and returns the PreparedPayment handle', async () => {
    installSupported();
    let captured: unknown;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({
          approvalId: 'apr_1',
          approvalStatus: 'PENDING',
          transactionId: 'tx_1',
        });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    expect(prepared.approvalId).toBe('apr_1');
    expect(prepared.transactionId).toBe('tx_1');
    expect(captured).toEqual({
      accept: REQUIREMENT,
      resource: CONTEXT.resource,
      x402Version: 2,
    });
  });

  it('forwards a valid paymentId as remotePaymentId', async () => {
    installSupported();
    let captured: unknown;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 't' });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await client.prepareInflowPayment(REQUIREMENT, CONTEXT, {
      paymentId: 'pay_abc1234567890_xyz',
    });
    expect(captured).toMatchObject({ remotePaymentId: 'pay_abc1234567890_xyz' });
  });

  it('throws X402PaymentIdFormatError before any POST when paymentId is invalid', async () => {
    installSupported();
    let posts = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () => {
        posts += 1;
        return HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 't' });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.prepareInflowPayment(REQUIREMENT, CONTEXT, { paymentId: 'bad id!' })).rejects.toBeInstanceOf(
      X402PaymentIdFormatError,
    );
    expect(posts).toBe(0);
  });

  it('throws X402AdapterRoutingError before any POST when InFlow does not cover the requirement', async () => {
    installSupported();
    let posts = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () => {
        posts += 1;
        return HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 't' });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const evmReq: PaymentRequirements = {
      scheme: 'exact',
      network: 'eip155:1',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      amount: '10000',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    };
    await expect(client.prepareInflowPayment(evmReq, CONTEXT)).rejects.toBeInstanceOf(X402AdapterRoutingError);
    expect(posts).toBe(0);
  });
});

describe('InflowClient.prepareInflowPayment — awaitPayload happy paths', () => {
  it('returns the signed payload immediately when the server signs synchronously', async () => {
    installSupported();
    const payload = makePayload();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'APPROVED', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const result = await prepared.awaitPayload();
    expect(result.transactionId).toBe('tx');
    expect(result.encodedPayload).toBe(encodedFor(payload));
    expect(result.paymentPayload).toEqual(payload);
  });

  it('polls past INITIATED until encodedPayload appears', async () => {
    installSupported();
    const payload = makePayload();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => {
        calls += 1;
        if (calls < 2) return HttpResponse.json({ status: 'INITIATED' });
        return HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const result = await prepared.awaitPayload({ pollIntervalMs: 5 });
    expect(result.encodedPayload).toBe(encodedFor(payload));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('swallows a transient 5xx mid-poll and continues', async () => {
    installSupported();
    const payload = makePayload();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ code: 'UNEXPECTED' }, { status: 500 });
        return HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const result = await prepared.awaitPayload({ pollIntervalMs: 5 });
    expect(result.encodedPayload).toBe(encodedFor(payload));
  });

  it('returns the same in-flight promise to concurrent awaitPayload callers', async () => {
    installSupported();
    const payload = makePayload();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'APPROVED', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(payload),
          paymentPayload: payload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const [a, b] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
    expect(a).toBe(b);
  });
});

describe('InflowClient.prepareInflowPayment — awaitPayload failure paths', () => {
  it('rejects with X402ApprovalFailedError when status leaves INITIATED with no payload', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => HttpResponse.json({ status: 'DECLINED' })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await expect(prepared.awaitPayload({ pollIntervalMs: 5 })).rejects.toBeInstanceOf(X402ApprovalFailedError);
  });

  it('rejects with X402ApprovalTimeoutError when timeoutMs elapses', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => HttpResponse.json({ status: 'INITIATED' })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await expect(prepared.awaitPayload({ pollIntervalMs: 5, timeoutMs: 30 })).rejects.toBeInstanceOf(
      X402ApprovalTimeoutError,
    );
  });

  it('rejects with X402ApprovalTimeoutError when the caller AbortSignal fires', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => HttpResponse.json({ status: 'INITIATED' })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      prepared.awaitPayload({ pollIntervalMs: 10, timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(X402ApprovalTimeoutError);
  });
});

describe('InflowClient.prepareInflowPayment — status and cancel', () => {
  it('status() returns the current TransactionStatus without waiting', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () => HttpResponse.json({ status: 'INITIATED' })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    expect(await prepared.status()).toBe('INITIATED');
  });

  it('cancel() breaks out of an in-flight awaitPayload with X402ApprovalCancelledError', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      // The GET stalls indefinitely so the loop is in a wait when cancel
      // fires. Without client-side cancellation the loop would sit until
      // timeoutMs (default 15 min).
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, async () => new Promise(() => undefined)),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () => new HttpResponse(null, { status: 204 })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    const awaitPromise = prepared.awaitPayload({ pollIntervalMs: 50, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    await prepared.cancel();
    await expect(awaitPromise).rejects.toBeInstanceOf(X402ApprovalCancelledError);
  });

  it('cancel() resolves on a server 204', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () => new HttpResponse(null, { status: 204 })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await expect(prepared.cancel()).resolves.toBeUndefined();
  });

  it('cancel() resolves on a server 4xx (already-approved / not-pending)', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () =>
        HttpResponse.json({ code: 'INVALID_APPROVAL_STATE' }, { status: 400 }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await expect(prepared.cancel()).resolves.toBeUndefined();
  });

  it('cancel() resolves on a server 5xx', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () => HttpResponse.json({}, { status: 500 })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await expect(prepared.cancel()).resolves.toBeUndefined();
  });

  it('cancel() rejects subsequent awaitPayload calls with X402ApprovalCancelledError', async () => {
    installSupported();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'apr_X', approvalStatus: 'PENDING', transactionId: 'tx' }),
      ),
      http.post(`${PROD_BASE}/v1/approvals/apr_X/cancel`, () => new HttpResponse(null, { status: 204 })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(REQUIREMENT, CONTEXT);
    await prepared.cancel();
    await expect(prepared.awaitPayload()).rejects.toBeInstanceOf(X402ApprovalCancelledError);
  });
});

describe('InflowClient.prepareInflowPayment — Permit2 path', () => {
  const PERMIT2_REQUIREMENT: PaymentRequirements = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0xseller',
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: 'permit2',
      permit2Proxy: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
    },
  };

  it('prepare forwards a Permit2 requirement byte-for-byte to the InFlow server', async () => {
    installSupported();
    let captured: { accept?: PaymentRequirements } | undefined;
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, async ({ request }) => {
        captured = (await request.json()) as { accept: PaymentRequirements };
        return HttpResponse.json({ approvalId: 'a', approvalStatus: 'PENDING', transactionId: 't' });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await client.prepareInflowPayment(PERMIT2_REQUIREMENT, CONTEXT);
    // The server-side Web3PaymentSigner dispatches on
    // extra.assetTransferMethod; the buyer must forward the seller's
    // accept entry verbatim (including extra.permit2Proxy) so the
    // facilitator's binding validator sees the same accept JSON it
    // stored at transaction-create time.
    expect(captured?.accept).toEqual(PERMIT2_REQUIREMENT);
  });

  it('awaitPayload surfaces the Permit2-shaped payload unchanged', async () => {
    installSupported();
    // Spec-shaped Permit2 payload: a single `permit2Authorization`
    // envelope with `permitted`, `from`, canonical `spender`, `nonce`,
    // `deadline`, `witness`, plus a top-level `signature`.
    const permit2Payload: InflowPaymentPayload = {
      x402Version: 2,
      accepted: PERMIT2_REQUIREMENT,
      payload: {
        signature: '0xsig',
        permit2Authorization: {
          permitted: { token: PERMIT2_REQUIREMENT.asset, amount: PERMIT2_REQUIREMENT.amount },
          from: '0xbuyer',
          spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
          nonce: '0x1',
          deadline: '1700000000',
          witness: { to: PERMIT2_REQUIREMENT.payTo, validAfter: '0', extra: '0x' },
        },
        transactionId: 'tx',
      },
    };
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () =>
        HttpResponse.json({ approvalId: 'a', approvalStatus: 'APPROVED', transactionId: 'tx' }),
      ),
      http.get(`${PROD_BASE}/v1/transactions/tx/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(permit2Payload),
          paymentPayload: permit2Payload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const prepared = await client.prepareInflowPayment(PERMIT2_REQUIREMENT, CONTEXT);
    const result = await prepared.awaitPayload();
    expect(result.paymentPayload).toEqual(permit2Payload);
    expect(result.encodedPayload).toBe(encodedFor(permit2Payload));
  });
});

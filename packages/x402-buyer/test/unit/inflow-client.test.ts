import { Buffer } from 'node:buffer';

import type { InflowPaymentPayload, PaymentRequirements } from '@inflowpayai/x402';
import {
  x402Client,
  type ClientExtension,
  type PaymentPolicy,
  type OnPaymentCreationFailureHook,
} from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, SchemeNetworkClient } from '@x402/core/types';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { InflowApiError } from '@inflowpayai/x402';
import { PAYMENT_IDENTIFIER } from '@inflowpayai/x402/extensions';

import { X402AdapterRoutingError, X402ApprovalFailedError } from '../../src/errors.js';
import { createInflowClient, InflowClient } from '../../src/inflow-client.js';
import { createInflowSigner } from '../../src/signer.js';

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

describe('managed selection and prepared lifecycle', () => {
  async function setup() {
    installSupported();
    const creates = vi.fn();
    const cancels = vi.fn();
    const polls = vi.fn();
    const signed = makeInflowPayload();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, async ({ request }) => {
        creates(await request.json());
        return HttpResponse.json({
          approvalId: 'apr_lifecycle',
          approvalStatus: 'APPROVED',
          transactionId: 'tx_lifecycle',
        });
      }),
      http.get(`${PROD_BASE}/v1/transactions/tx_lifecycle/x402`, () => {
        polls();
        return HttpResponse.json({ status: 'SETTLED', encodedPayload: encodedFor(signed), paymentPayload: signed });
      }),
      http.post(`${PROD_BASE}/v1/approvals/apr_lifecycle/cancel`, () => {
        cancels();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return { client: await createInflowClient({ apiKey: 'sk_test' }), creates, cancels, polls, signed };
  }

  it('applies transformations once and leaves caller data unchanged', async () => {
    const { client, creates } = await setup();
    const required = paymentRequired([INFLOW_REQ]);
    const policy = vi.fn<PaymentPolicy>((_version, requirements) =>
      requirements.map((r) => ({ ...r, amount: '2000' })),
    );
    client.registerPolicy(policy);
    const selected = await client.selectInflowRequirement(required);
    if (selected === null) throw new Error('Expected managed selection');
    await client.prepareInflowPayment(selected, required);
    expect(policy).toHaveBeenCalledOnce();
    expect(creates.mock.calls[0]?.[0]).toMatchObject({ accept: { amount: '2000' } });
    expect(required.accepts[0]?.amount).toBe('1000');
  });

  it('does not fall back to external signing when a policy rejects managed payment', async () => {
    const { client, creates } = await setup();
    const sign = vi.fn(() => Promise.resolve({ x402Version: 2, payload: {} }));
    client.register('eip155:1', { scheme: 'exact', createPaymentPayload: sign });
    client.registerPolicy(() => []);
    await expect(client.createPaymentPayload(paymentRequired([INFLOW_REQ, EVM_REQ]))).rejects.toThrow('filtered out');
    expect(creates).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects a policy transformation that cannot be signed', async () => {
    const { client, creates } = await setup();
    client.registerPolicy(() => paymentRequired([EVM_REQ]).accepts);
    await expect(client.createPaymentPayload(paymentRequired([INFLOW_REQ]))).rejects.toThrow('no supported InFlow');
    expect(creates).not.toHaveBeenCalled();
  });

  it.each(['manual', 'extension'] as const)('stops preparation before the POST on a %s abort', async (kind) => {
    const { client, creates } = await setup();
    const hook = vi.fn(() => Promise.resolve({ abort: true as const, reason: 'blocked' }));
    if (kind === 'manual') client.onBeforePaymentCreation(hook);
    else client.registerExtension({ key: 'guard', hooks: { onBeforePaymentCreation: hook } });
    const failure = vi.fn();
    client.onPaymentCreationFailure(failure);
    await expect(client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ], { guard: {} }))).rejects.toThrow(
      'blocked',
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(creates).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it('shares completion hooks and preserves encoded bytes despite observer mutation', async () => {
    const { client, polls, signed } = await setup();
    const events: string[] = [];
    client.onBeforePaymentCreation(() => {
      events.push('manual-before');
      return Promise.resolve();
    });
    client.onAfterPaymentCreation(({ paymentPayload }) => {
      events.push('manual-after');
      paymentPayload.payload = { changed: true };
      return Promise.resolve();
    });
    client.registerExtension({
      key: 'guard',
      hooks: {
        onBeforePaymentCreation: () => {
          events.push('extension-before');
          return Promise.resolve();
        },
        onAfterPaymentCreation: (_declaration, { paymentPayload }) => {
          events.push('extension-after');
          expect(paymentPayload).toEqual(signed);
          return Promise.resolve();
        },
      },
    });
    const absent = vi.fn();
    client.registerExtension({ key: 'absent', hooks: { onAfterPaymentCreation: absent } });
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ], { guard: {} }));
    const [first, second] = await Promise.all([prepared.awaitPayload(), prepared.awaitPayload()]);
    expect(first).toBe(second);
    expect(await prepared.awaitPayload()).toBe(first);
    expect(first.encodedPayload).toBe(encodedFor(signed));
    expect(first.paymentPayload).toEqual(signed);
    expect(events).toEqual(['manual-before', 'extension-before', 'manual-after', 'extension-after']);
    expect(polls).toHaveBeenCalledOnce();
    expect(absent).not.toHaveBeenCalled();
  });

  it('does not repeat failed after hooks or substitute a recovery payment', async () => {
    const { client, creates, cancels } = await setup();
    const error = new Error('observer failed');
    const after = vi.fn(() => Promise.reject(error));
    const recovery = vi.fn(() =>
      Promise.resolve({
        recovered: true as const,
        payload: { x402Version: 2, accepted: { ...INFLOW_REQ, network: 'inflow:1' as const, extra: {} }, payload: {} },
      }),
    );
    client.onAfterPaymentCreation(after).onPaymentCreationFailure(recovery);
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]));
    await expect(prepared.awaitPayload()).rejects.toBe(error);
    await expect(prepared.awaitPayload()).rejects.toBe(error);
    expect(after).toHaveBeenCalledOnce();
    expect(creates).toHaveBeenCalledOnce();
    expect(cancels).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
  });

  it.each(['last', 'followed', 'rejects'] as const)('honors cancellation during an after hook (%s)', async (mode) => {
    const { client, cancels } = await setup();
    let start = () => {};
    let finish = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.onAfterPaymentCreation(async () => {
      start();
      await release;
      if (mode === 'rejects') throw new Error('late hook failure');
    });
    const later = vi.fn();
    if (mode === 'followed') client.onAfterPaymentCreation(later);
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]));
    const waiting = prepared.awaitPayload();
    const rejection = expect(waiting).rejects.toThrow('cancelled');
    await started;
    await prepared.cancel();
    finish();
    await rejection;
    await expect(prepared.awaitPayload()).rejects.toThrow('cancelled');
    expect(cancels).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it('runs declared extension hooks on one-shot success and recovery', async () => {
    const { client } = await setup();
    const before = vi.fn(() => Promise.resolve());
    const after = vi.fn(() => Promise.resolve());
    const recovered: PaymentPayload = {
      x402Version: 2,
      accepted: { ...INFLOW_REQ, network: 'inflow:1', extra: {} },
      payload: { recovered: true },
    };
    const failure = vi.fn(() => Promise.resolve({ recovered: true as const, payload: recovered }));
    const ignored = vi.fn();
    client.registerExtension({
      key: 'guard',
      hooks: { onBeforePaymentCreation: before, onAfterPaymentCreation: after, onPaymentCreationFailure: failure },
    });
    client.registerExtension({ key: 'absent', hooks: { onPaymentCreationFailure: ignored } });
    const required = paymentRequired([INFLOW_REQ], { guard: { info: {} } });
    await client.createPaymentPayload(required);
    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/tx_lifecycle/x402`, () => HttpResponse.json({ status: 'DECLINED' })),
    );
    await expect(client.createPaymentPayload(required)).resolves.toBe(recovered);
    expect(failure).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
  });

  it('propagates preparation errors without recovery and does not poll', async () => {
    const { client, polls } = await setup();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () => HttpResponse.json({ message: 'rejected' }, { status: 400 })),
    );
    const failure = vi.fn();
    client.onPaymentCreationFailure(failure);
    await expect(client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]))).rejects.toBeInstanceOf(
      InflowApiError,
    );
    expect(failure).not.toHaveBeenCalled();
    expect(polls).not.toHaveBeenCalled();
  });

  it('keeps status available and prevents waiting after cancellation', async () => {
    const { client, polls } = await setup();
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]));
    await expect(prepared.status()).resolves.toBe('SETTLED');
    await prepared.cancel();
    await expect(prepared.awaitPayload()).rejects.toThrow('cancelled');
    expect(polls).toHaveBeenCalledOnce();
  });

  it('normalizes absent extra for hook contexts without mutating the caller', async () => {
    const { client, creates } = await setup();
    const { extra: _extra, ...requirement } = INFLOW_REQ;
    const before = vi.fn(() => Promise.resolve());
    client.onBeforePaymentCreation(before);
    await client.prepareInflowPayment(requirement, paymentRequired([requirement]));
    expect(before.mock.calls[0]).toBeDefined();
    expect(creates.mock.calls[0]?.[0]).toMatchObject({ accept: { extra: {} } });
    expect(requirement).not.toHaveProperty('extra');
  });

  it('runs external-wallet policies once through foundation selection', async () => {
    const { client, creates } = await setup();
    const policy = vi.fn<PaymentPolicy>((_version, requirements) => requirements);
    client.registerPolicy(policy);
    client.register('eip155:1', {
      scheme: 'exact',
      findDefaultAsset: () => ({ asset: EVM_REQ.asset, decimals: 6, symbol: 'USDC' }),
      createPaymentPayload: () => Promise.resolve({ x402Version: 2, payload: { external: true } }),
    });
    await expect(client.createPaymentPayload(paymentRequired([EVM_REQ]))).resolves.toHaveProperty(
      'payload.external',
      true,
    );
    expect(policy).toHaveBeenCalledOnce();
    expect(creates).not.toHaveBeenCalled();
  });

  it('does not create an approval after a before-hook exception', async () => {
    const { client, creates } = await setup();
    const error = new Error('before failed');
    client.onBeforePaymentCreation(() => Promise.reject(error));
    await expect(client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]))).rejects.toBe(error);
    expect(creates).not.toHaveBeenCalled();
  });

  it('preserves before-hook request snapshots', async () => {
    const { client, creates } = await setup();
    const required = paymentRequired([INFLOW_REQ]);
    client.onBeforePaymentCreation(({ selectedRequirements, paymentRequired: observed }) => {
      selectedRequirements.amount = '999';
      observed.resource.url = 'https://different.example';
      return Promise.resolve();
    });
    await client.prepareInflowPayment(INFLOW_REQ, required);
    expect(creates.mock.calls[0]?.[0]).toMatchObject({ accept: { amount: '1000' }, resource: required.resource });
  });

  it('propagates an aborted wait without recovery or automatic two-phase cancellation', async () => {
    const { client, cancels } = await setup();
    const controller = new AbortController();
    const recovery = vi.fn();
    client.onPaymentCreationFailure(recovery);
    const prepared = await client.prepareInflowPayment(INFLOW_REQ, paymentRequired([INFLOW_REQ]));
    controller.abort();
    await expect(prepared.awaitPayload({ signal: controller.signal })).rejects.toThrow();
    expect(recovery).not.toHaveBeenCalled();
    expect(cancels).not.toHaveBeenCalled();
    await expect(prepared.awaitPayload()).resolves.toHaveProperty('transactionId', 'tx_lifecycle');
  });
});

describe.each(['managed', 'foundation'] as const)('payment-creation hooks — %s', (route) => {
  async function setup(failAt?: 'create' | 'poll') {
    installSupported();
    const required = paymentRequired([route === 'managed' ? INFLOW_REQ : EVM_REQ]);
    const events: string[] = [];
    const cancels = vi.fn();
    const signed = makeInflowPayload();
    server.use(
      http.post(`${PROD_BASE}/v1/transactions/x402`, () => {
        events.push('create');
        if (failAt === 'create') {
          return HttpResponse.json({ code: 'TEST_REJECTION', message: 'creation rejected' }, { status: 400 });
        }
        return HttpResponse.json({ approvalId: 'apr_hooks', approvalStatus: 'APPROVED', transactionId: 'tx_hooks' });
      }),
      http.get(`${PROD_BASE}/v1/transactions/tx_hooks/x402`, () => {
        events.push('poll');
        return HttpResponse.json(
          failAt === 'poll'
            ? { status: 'DECLINED' }
            : { status: 'SETTLED', encodedPayload: encodedFor(signed), paymentPayload: signed },
        );
      }),
      http.post(`${PROD_BASE}/v1/approvals/apr_hooks/cancel`, () => {
        cancels();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const scheme = {
      scheme: 'exact',
      findDefaultAsset: (asset: string, network: string) =>
        asset === EVM_REQ.asset && network === EVM_REQ.network ? { asset, decimals: 6, symbol: 'USDC' } : undefined,
      createPaymentPayload: () => {
        events.push('sign');
        if (failAt !== undefined) throw new Error('external signing rejected');
        return Promise.resolve({ x402Version: 2, payload: { signature: 'external' } });
      },
    };
    client.register('eip155:1', scheme);
    return { client, required, events, cancels };
  }

  it.each(['abort', 'throw'] as const)('stops before creation on a before-hook %s, without recovery', async (mode) => {
    const { client, required, events } = await setup();
    const failure = vi.fn();
    const later = vi.fn();
    const blocked = new Error('policy threw');
    client.onBeforePaymentCreation((context) => {
      expect(context.paymentRequired).toBe(required);
      expect(context.selectedRequirements).toBe(required.accepts[0]);
      events.push('before');
      if (mode === 'throw') throw blocked;
      return Promise.resolve({ abort: true, reason: 'policy blocked' });
    });
    client.onBeforePaymentCreation(later).onAfterPaymentCreation(later).onPaymentCreationFailure(failure);
    const result = client.createPaymentPayload(required);
    if (mode === 'throw') await expect(result).rejects.toBe(blocked);
    else await expect(result).rejects.toThrow('Payment creation aborted: policy blocked');
    expect(events).toEqual(['before']);
    expect(later).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it('awaits hooks in order and passes the selected requirement and final payload', async () => {
    const { client, required, events } = await setup();
    const after = vi.fn();
    const failure = vi.fn();
    client.onBeforePaymentCreation(async () => {
      await Promise.resolve();
      events.push('before-1');
    });
    client.onBeforePaymentCreation(() => {
      events.push('before-2');
      return Promise.resolve();
    });
    client.onAfterPaymentCreation(async (context) => {
      await Promise.resolve();
      after(context);
      events.push('after-1');
    });
    client.onAfterPaymentCreation(() => {
      events.push('after-2');
      return Promise.resolve();
    });
    client.onPaymentCreationFailure(failure);
    const payload = await client.createPaymentPayload(required);
    expect(events).toEqual([
      'before-1',
      'before-2',
      ...(route === 'managed' ? ['create', 'poll'] : ['sign']),
      'after-1',
      'after-2',
    ]);
    expect(after).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: required,
      selectedRequirements: required.accepts[0],
      paymentPayload: payload,
    });
    expect(failure).not.toHaveBeenCalled();
  });

  it.each(['create', 'poll'] as const)(
    'reports %s failures and preserves cancellation and error identity',
    async (failAt) => {
      const { client, required, cancels } = await setup(failAt);
      const failure = vi.fn();
      const after = vi.fn();
      client.onPaymentCreationFailure(failure).onAfterPaymentCreation(after);
      const error: unknown = await client.createPaymentPayload(required).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(failure).toHaveBeenCalledExactlyOnceWith({
        paymentRequired: required,
        selectedRequirements: required.accepts[0],
        error,
      });
      expect(after).not.toHaveBeenCalled();
      if (route === 'managed' && failAt === 'poll') {
        expect(error).toBeInstanceOf(X402ApprovalFailedError);
        await vi.waitFor(() => expect(cancels).toHaveBeenCalledOnce());
      } else {
        if (route === 'managed') expect(error).toMatchObject({ code: 'TEST_REJECTION', httpStatus: 400 });
        expect(cancels).not.toHaveBeenCalled();
      }
    },
  );

  it('uses the first recovery payload and does not call after hooks on recovery', async () => {
    const { client, required } = await setup('create');
    const recovered: PaymentPayload = {
      x402Version: 2,
      accepted: { ...EVM_REQ, network: 'eip155:1', extra: {} },
      payload: { signature: 'recovery' },
    };
    const order: string[] = [];
    const later = vi.fn();
    client.onPaymentCreationFailure(() => {
      order.push('observe');
      return Promise.resolve();
    });
    client.onPaymentCreationFailure(() => {
      order.push('decline');
      return Promise.resolve();
    });
    client.onPaymentCreationFailure(() => {
      order.push('recover');
      return Promise.resolve({ recovered: true, payload: recovered });
    });
    client.onPaymentCreationFailure(later).onAfterPaymentCreation(later);
    await expect(client.createPaymentPayload(required)).resolves.toBe(recovered);
    expect(order).toEqual(['observe', 'decline', 'recover']);
    expect(later).not.toHaveBeenCalled();
  });

  it('routes after-hook exceptions through failure hooks without cancelling completed signing', async () => {
    const { client, required, cancels } = await setup();
    const error = new Error('after failed');
    const failure = vi.fn();
    const later = vi.fn();
    client.onAfterPaymentCreation(() => Promise.reject(error));
    client.onAfterPaymentCreation(later).onPaymentCreationFailure(failure);
    await expect(client.createPaymentPayload(required)).rejects.toBe(error);
    expect(failure).toHaveBeenCalledExactlyOnceWith({
      paymentRequired: required,
      selectedRequirements: required.accepts[0],
      error,
    });
    expect(later).not.toHaveBeenCalled();
    expect(cancels).not.toHaveBeenCalled();
  });

  it('propagates a failure-hook exception without invoking later recovery', async () => {
    const { client, required } = await setup('create');
    const error = new Error('failure hook threw');
    const later = vi.fn();
    client.onPaymentCreationFailure(() => Promise.reject(error));
    client.onPaymentCreationFailure(later);
    await expect(client.createPaymentPayload(required)).rejects.toBe(error);
    expect(later).not.toHaveBeenCalled();
  });

  if (route === 'managed') {
    it('checks the balance-selected requirement before any transaction is created', async () => {
      const { client, events } = await setup();
      const first = { ...INFLOW_REQ, extra: { assetName: 'USDC' } };
      const second = { ...INFLOW_REQ, extra: { assetName: 'USDT' } };
      const required = paymentRequired([first, second]);
      server.use(
        http.get(`${PROD_BASE}/v1/balances`, () => {
          events.push('balances');
          return HttpResponse.json({ balances: [{ currency: 'USDT', available: '1' }] });
        }),
      );
      client.onBeforePaymentCreation((context) => {
        expect(context.selectedRequirements).toBe(second);
        return Promise.resolve({ abort: true, reason: 'selected asset blocked' });
      });
      await expect(client.createPaymentPayload(required)).rejects.toThrow(
        'Payment creation aborted: selected asset blocked',
      );
      expect(events).toEqual(['balances']);
    });

    it('supplies an Error to failure hooks for a non-Error rejection while rethrowing the original value', async () => {
      const { client, required } = await setup();
      const failure = vi.fn<OnPaymentCreationFailureHook>();
      client.onAfterPaymentCreation(vi.fn().mockRejectedValue('rejected value'));
      client.onPaymentCreationFailure(failure);
      await expect(client.createPaymentPayload(required)).rejects.toBe('rejected value');
      expect(failure).toHaveBeenCalledExactlyOnceWith({
        paymentRequired: required,
        selectedRequirements: required.accepts[0],
        error: new Error('rejected value', { cause: 'rejected value' }),
      });
      expect(failure.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
    });
  }

  it('defers before hooks registered during a before phase until the next payment', async () => {
    const { client, required } = await setup();
    const late = vi.fn();
    client.onBeforePaymentCreation(() => {
      client.onBeforePaymentCreation(late);
      return Promise.resolve();
    });
    await client.createPaymentPayload(required);
    expect(late).not.toHaveBeenCalled();
    await client.createPaymentPayload(required);
    expect(late).toHaveBeenCalledOnce();
  });

  it('keeps concurrent payment hook contexts separate', async () => {
    const { client, required, events } = await setup();
    const blocked = { ...required, resource: { url: 'https://example.com/blocked' } };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const after = vi.fn();
    client.onBeforePaymentCreation(async (context) => {
      if (context.paymentRequired === blocked) {
        await gate;
        return { abort: true, reason: 'blocked request' };
      }
    });
    client.onAfterPaymentCreation(after);
    const pending = client.createPaymentPayload(blocked);
    try {
      const payload = await client.createPaymentPayload(required);
      expect(after).toHaveBeenCalledExactlyOnceWith({
        paymentRequired: required,
        selectedRequirements: required.accepts[0],
        paymentPayload: payload,
      });
    } finally {
      release?.();
      await expect(pending).rejects.toThrow('Payment creation aborted: blocked request');
    }
    expect(events).toEqual(route === 'managed' ? ['create', 'poll'] : ['sign']);
  });
});

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

describe('Permit2 treasury boundary', () => {
  const requirement: PaymentRequirements = {
    ...EVM_REQ,
    network: 'eip155:8453',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    extra: { ...EVM_REQ.extra, assetTransferMethod: 'permit2' },
  };

  it('routes Permit2 to the external scheme even when InFlow supports the same exact network', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const createPaymentPayload = vi.fn(() => Promise.resolve({ x402Version: 2, payload: { signature: 'external' } }));
    const externalScheme = {
      scheme: 'exact',
      createPaymentPayload,
      findDefaultAsset: (asset: string, network: string) =>
        asset === requirement.asset && network === requirement.network
          ? { asset, decimals: 6, symbol: 'USDC' }
          : undefined,
    };
    client.register('eip155:8453', externalScheme);
    const required = paymentRequired([requirement]);
    expect(await client.selectInflowRequirement(required)).toBeNull();
    expect((await client.createPaymentPayload(required)).payload).toEqual({ signature: 'external' });
    expect(createPaymentPayload).toHaveBeenCalledOnce();
  });

  it('rejects both two-phase and direct managed signing before any payment request', async () => {
    installSupported();
    const signer = await createInflowSigner({ apiKey: 'sk_test' });
    const client = new InflowClient(signer);
    const context = { x402Version: 2, resource: { url: 'https://example.com/payment' } };
    expect(signer.supports(requirement)).toBe(false);
    await expect(client.prepareInflowPayment(requirement, context)).rejects.toBeInstanceOf(X402AdapterRoutingError);
    await expect(signer.prepare(requirement, context)).rejects.toBeInstanceOf(X402AdapterRoutingError);
    await expect(signer.sign(requirement, context)).rejects.toBeInstanceOf(X402AdapterRoutingError);
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
        paymentRequired([EVM_REQ], { 'payment-identifier': PAYMENT_IDENTIFIER.buildDeclaration({}) }),
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
        client.createPaymentPayload(
          paymentRequired([EVM_REQ], {
            'payment-identifier': { ...PAYMENT_IDENTIFIER.buildDeclaration({}), info: { required: true } },
          }),
        ),
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

describe('InflowClient.getSupported', () => {
  it('serves the second call from cache within the 60-min TTL — exactly one underlying HTTP call', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/x402-supported`, () => {
        calls += 1;
        return HttpResponse.json(SUPPORTED);
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const a = await client.getSupported();
    const b = await client.getSupported();
    // The prime in createInflowClient is the single network call; both getSupported() calls observe the cached value.
    expect(calls).toBe(1);
    expect(a).toEqual(SUPPORTED);
    expect(b).toEqual(SUPPORTED);
  });
});

describe('InflowClient.selectInflowRequirement', () => {
  it('returns the first balance entry under default prefer ["balance","exact"]', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const exactReq: PaymentRequirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    };
    const match = await client.selectInflowRequirement(paymentRequired([INFLOW_REQ, exactReq]));
    expect(match).toEqual(INFLOW_REQ);
  });

  it('returns null when no accepts entry is in the buyer capability cache', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test' });
    // EVM_REQ.network is 'eip155:1'; the buyer cache covers 'eip155:8453'. Same scheme, different network.
    const match = await client.selectInflowRequirement(paymentRequired([EVM_REQ]));
    expect(match).toBeNull();
  });

  it('returns null on an empty accepts[] without making an extra HTTP call', async () => {
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/x402-supported`, () => {
        calls += 1;
        return HttpResponse.json(SUPPORTED);
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const match = await client.selectInflowRequirement(paymentRequired([]));
    expect(match).toBeNull();
    // Only the construction-time prime; an empty accepts[] matches nothing, so selection never reaches the
    // balances endpoint or any other extra HTTP call.
    expect(calls).toBe(1);
  });

  it('honors a caller-configured prefer order — "exact" wins over "balance" when prefer leads with "exact"', async () => {
    installSupported();
    const client = await createInflowClient({ apiKey: 'sk_test', prefer: ['exact', 'balance'] });
    const exactReq: PaymentRequirements = {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0xUSDC',
      amount: '10000',
      payTo: '0xseller',
      maxTimeoutSeconds: 300,
      extra: {},
    };
    // Both entries are in the buyer capability cache; prefer order picks the exact one even though balance appears first
    // in the accepts array.
    const match = await client.selectInflowRequirement(paymentRequired([INFLOW_REQ, exactReq]));
    expect(match).toEqual(exactReq);
  });

  // amount '10000000000000000' = 0.01 at INFLOW_AMOUNT_SCALE (18).
  const balanceRow = (assetName: string): PaymentRequirements => ({
    scheme: 'balance',
    network: 'inflow:1',
    asset: '',
    amount: '10000000000000000',
    payTo: '00000000-0000-0000-0000-000000000001',
    maxTimeoutSeconds: 300,
    extra: { assetName },
  });

  it('prefers a balance asset the buyer can cover when several are advertised', async () => {
    installSupported();
    // Server advertises USDT first (zero balance); selection must skip it for the first affordable asset.
    server.use(
      http.get(`${PROD_BASE}/v1/balances`, () =>
        HttpResponse.json({
          balances: [
            { currency: 'USDT', available: '0' },
            { currency: 'USDC', available: '78.3757' },
            { currency: 'PYUSD', available: '89.19762' },
          ],
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const match = await client.selectInflowRequirement(
      paymentRequired([balanceRow('USDT'), balanceRow('USDC'), balanceRow('PYUSD')]),
    );
    expect(match?.extra?.['assetName']).toBe('USDC');
  });

  it('falls back to the first balance entry when balances cannot be read', async () => {
    installSupported();
    server.use(http.get(`${PROD_BASE}/v1/balances`, () => new HttpResponse(null, { status: 500 })));
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const match = await client.selectInflowRequirement(paymentRequired([balanceRow('USDT'), balanceRow('USDC')]));
    expect(match?.extra?.['assetName']).toBe('USDT');
  });

  it('skips malformed or unmatched balance requirements when an affordable entry follows', async () => {
    installSupported();
    server.use(
      http.get(`${PROD_BASE}/v1/balances`, () =>
        HttpResponse.json({
          balances: [{ currency: 'USDC', available: '1' }],
        }),
      ),
    );
    const missingAssetName = { ...balanceRow('USDC'), extra: {} };
    const unmatchedAsset = balanceRow('USDT');
    const invalidAmount = { ...balanceRow('USDC'), amount: 'not-an-integer' };
    const affordable = balanceRow('USDC');
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const match = await client.selectInflowRequirement(
      paymentRequired([missingAssetName, unmatchedAsset, invalidAmount, affordable]),
    );
    expect(match).toEqual(affordable);
  });
});

describe('InflowClient.getX402Payload', () => {
  it('returns the INITIATED shape with no encodedPayload', async () => {
    installSupported();
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/tx_pending/x402`, () => HttpResponse.json({ status: 'INITIATED' })),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const payload = await client.getX402Payload('tx_pending');
    expect(payload).toEqual({ status: 'INITIATED' });
  });

  it('returns the APPROVED shape with encodedPayload and paymentPayload', async () => {
    installSupported();
    const inflowPayload = makeInflowPayload();
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/tx_signed/x402`, () =>
        HttpResponse.json({
          status: 'SETTLED',
          encodedPayload: encodedFor(inflowPayload),
          paymentPayload: inflowPayload,
        }),
      ),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    const payload = await client.getX402Payload('tx_signed');
    expect(payload.status).toBe('SETTLED');
    expect(payload.encodedPayload).toBe(encodedFor(inflowPayload));
    expect(payload.paymentPayload).toEqual(inflowPayload);
  });

  it('honors retries: 0 — a single 503 throws InflowApiError without retry', async () => {
    installSupported();
    let calls = 0;
    server.use(
      http.get(`${PROD_BASE}/v1/transactions/tx_5xx/x402`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'UNEXPECTED' }, { status: 503 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.getX402Payload('tx_5xx')).rejects.toBeInstanceOf(InflowApiError);
    expect(calls).toBe(1);
  });
});

describe('InflowClient.cancelApproval', () => {
  it('resolves on a server 200 — single network call', async () => {
    installSupported();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/approvals/apr_ok/cancel`, () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.cancelApproval('apr_ok')).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('swallows a server 5xx without retry — single network call', async () => {
    installSupported();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/approvals/apr_5xx/cancel`, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.cancelApproval('apr_5xx')).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('swallows a server 4xx — single network call', async () => {
    installSupported();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/approvals/apr_4xx/cancel`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'INVALID_APPROVAL_STATE' }, { status: 400 });
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.cancelApproval('apr_4xx')).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('swallows a mid-request network error', async () => {
    installSupported();
    let calls = 0;
    server.use(
      http.post(`${PROD_BASE}/v1/approvals/apr_net/cancel`, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    const client = await createInflowClient({ apiKey: 'sk_test' });
    await expect(client.cancelApproval('apr_net')).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('rethrows an auth-callback rejection verbatim in bearer mode', async () => {
    installSupported();
    // The prime fetch in createInflowClient consumes the first token; the second token request — fired by cancelApproval
    // — rejects with the raw auth error and the InflowHttpClient propagates it without wrapping in InflowApiError.
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('prime-token')
      .mockRejectedValueOnce(new Error('auth-fail'));
    const client = await createInflowClient({ getAccessToken });
    await expect(client.cancelApproval('apr_auth')).rejects.toThrow('auth-fail');
  });
});

describe('createInflowSigner.getBalances', () => {
  it('normalizes ledger balance decimal strings, dropping trailing zeros', async () => {
    installSupported();
    server.use(
      http.get(`${PROD_BASE}/v1/balances`, () =>
        HttpResponse.json({
          balances: [
            { currency: 'USDC', available: '0.010000000000000000' },
            { currency: 'PYUSD', available: '89.197620000000000000' },
            { currency: 'USDT', available: '0.000000000000000000' },
          ],
        }),
      ),
    );
    const signer = await createInflowSigner({ apiKey: 'sk_test' });
    expect(await signer.getBalances()).toEqual([
      { currency: 'USDC', available: '0.01' },
      { currency: 'PYUSD', available: '89.19762' },
      { currency: 'USDT', available: '0' },
    ]);
  });
});

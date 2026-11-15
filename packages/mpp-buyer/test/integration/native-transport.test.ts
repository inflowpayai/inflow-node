import { once } from 'node:events';
import { createServer } from 'node:http';

import { decodeCredential, encode, encodeCredential, renderChallengeHeader } from '@inflowpayai/mpp';
import type { MppChallenge } from '@inflowpayai/mpp';
import { Errors } from 'mppx';
import { Fetch } from 'mppx/client';
import { expect, it, vi } from 'vitest';

import { inflow, MppPaymentCancelledError, Mppx } from '../../src/index.js';

function platformRequest(init: RequestInit | undefined): { challenge: MppChallenge; options: Record<string, unknown> } {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as { challenge: MppChallenge; options: Record<string, unknown> };
}

async function fixture(outcome: 'success' | 'error' | 'disconnect' | 'reject' | 'repeat' = 'success', header?: string) {
  const offers = ['first', 'second'].map((id): MppChallenge => ({
    id,
    realm: 'seller.test',
    method: 'inflow',
    intent: 'charge',
    request: encode({ amount: '1', currency: 'USD' }),
    ...(header === undefined ? {} : { header }),
  }));
  const payments: string[] = [];
  const paths: string[] = [];
  const applicationAuth: (string | undefined)[] = [];
  const platform = vi.fn<typeof globalThis.fetch>((_input, init) => {
    const body = platformRequest(init);
    return Promise.resolve(
      Response.json({
        state: 'ready',
        credential: encodeCredential({
          challenge: body.challenge,
          source: 'did:inflow:test',
          payload: { transactionId: body.challenge.id },
        }),
      }),
    );
  });
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    applicationAuth.push(request.headers.authorization);
    const authorization = request.headers[(header ?? 'Authorization').toLowerCase()];
    if (typeof authorization !== 'string') {
      response.writeHead(402, { 'WWW-Authenticate': offers.map(renderChallengeHeader).join(', ') }).end('{}');
      return;
    }
    payments.push(decodeCredential(authorization.replace(/^Payment /u, '')).challenge.id);
    if (outcome === 'disconnect') {
      request.socket.destroy();
      return;
    }
    if (outcome === 'repeat') {
      response.writeHead(402, { 'WWW-Authenticate': offers.map(renderChallengeHeader).join(', ') }).end('{}');
      return;
    }
    response.writeHead(outcome === 'error' ? 500 : outcome === 'reject' ? 401 : 200).end('result');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const method = inflow({ apiKey: 'test-key', fetch: platform });
  const config = { methods: [method], polyfill: false, maxPaymentRetries: 1 } as const;
  return {
    url: `http://127.0.0.1:${String(address.port)}/paid`,
    platform,
    paths,
    payments,
    applicationAuth,
    config,
    close: async () => {
      method.cleanup();
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

it.each(['Payment-Authorization', 'X-Payment'])(
  'pays through %s without replacing application authorization',
  async (header) => {
    const f = await fixture('success', header);
    try {
      const buyer = Mppx.create(f.config);
      const response = await buyer.fetch(f.url, { headers: { Authorization: 'Bearer application-token' } });
      expect(await response.text()).toBe('result');
      expect(f.applicationAuth).toEqual(['Bearer application-token', 'Bearer application-token']);
      expect(f.payments).toEqual(['first']);
      expect(f.platform).toHaveBeenCalledTimes(1);
      expect(platformRequest(f.platform.mock.calls[0]?.[1]).challenge.header).toBe(header);
    } finally {
      await f.close();
    }
  },
);

it('opts out for one request without disabling subsequent payments on the same client', async () => {
  const f = await fixture();
  try {
    const buyer = Mppx.create(f.config);
    const unpaid = await buyer.fetch(f.url, Fetch.withoutPayment());
    expect(unpaid.status).toBe(402);
    await unpaid.text();
    expect(f.platform).not.toHaveBeenCalled();
    expect(f.paths).toHaveLength(1);
    expect(await (await buyer.fetch(f.url)).text()).toBe('result');
    expect(f.platform).toHaveBeenCalledTimes(1);
    expect(f.payments).toEqual(['first']);
  } finally {
    await f.close();
  }
});

it('cancels a pending approval through request context without cancelling another request', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let pollSignal: AbortSignal | undefined;
  const cancelled = vi.fn();
  const ready = f.platform.getMockImplementation();
  if (!ready) throw new Error('Expected platform fixture');
  let creates = 0;
  f.platform.mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/cancel')) {
      expect(url).toContain('/approvals/pending-approval/cancel');
      expect(init?.signal?.aborted).toBe(false);
      cancelled();
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (init?.method === 'POST') {
      expect(platformRequest(init).options).toEqual({});
      creates += 1;
      return creates === 1
        ? Promise.resolve(
            Response.json({
              state: 'pending',
              transactionId: 'pending-transaction',
              approvalId: 'pending-approval',
              retryAfterSeconds: 0,
            }),
          )
        : ready(input, init);
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected poll signal');
      pollSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  try {
    const buyer = Mppx.create(f.config);
    const pending = buyer
      .fetch(f.url, { signal: controller.signal, context: { signal: controller.signal } })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(pollSignal).toBeDefined());
    expect(await (await buyer.fetch(f.url)).text()).toBe('result');
    controller.abort();
    expect(await pending).toBeInstanceOf(MppPaymentCancelledError);
    expect(pollSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(f.payments).toEqual(['first']);
    expect(await (await buyer.fetch(f.url)).text()).toBe('result');
    expect(creates).toBe(3);
  } finally {
    controller.abort();
    await f.close();
  }
});

it('keeps concurrent request-local selection separate from client defaults and payment context', async () => {
  const f = await fixture();
  try {
    const buyer = Mppx.create({ ...f.config, orderChallenges: (candidates) => [...candidates].reverse() });
    const responses = await Promise.all([
      buyer.fetch(f.url, {
        orderChallenges: (candidates) => candidates.filter(({ challenge }) => challenge.id === 'first'),
        context: { instrumentId: '00000000-0000-4000-8000-000000000001' },
      }),
      buyer.fetch(f.url),
    ]);
    await Promise.all(responses.map((response) => response.text()));
    expect([...f.payments].sort()).toEqual(['first', 'second']);
    const requests = f.platform.mock.calls.map(([, init]) => platformRequest(init));
    expect(requests.find(({ challenge }) => challenge.id === 'first')?.options).toEqual({
      instrumentId: '00000000-0000-4000-8000-000000000001',
    });
    expect(requests.find(({ challenge }) => challenge.id === 'second')?.options).toEqual({});
  } finally {
    await f.close();
  }
});

it.each(['filter', 'preference', 'abort'] as const)('prevents payment before credential creation: %s', async (mode) => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const buyer = Mppx.create({
      ...f.config,
      ...(mode === 'preference' ? { paymentPreferences: { 'inflow/charge': 0 } } : {}),
      orderChallenges: (candidates) => {
        if (mode === 'abort') controller.abort(new Error('cancelled before approval'));
        return mode === 'filter' ? [] : candidates;
      },
    });
    await expect(buyer.fetch(f.url, { signal: controller.signal })).rejects.toThrow();
    expect(f.platform).not.toHaveBeenCalled();
    expect(f.payments).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['error', 'disconnect', 'reject', 'repeat'] as const)(
  'does not start a second payment after %s',
  async (outcome) => {
    const f = await fixture(outcome);
    try {
      const buyer = Mppx.create(f.config);
      const failures: unknown[] = [];
      buyer.onPaymentFailed(({ error }) => {
        failures.push(error);
      });
      if (outcome === 'disconnect') await expect(buyer.fetch(f.url)).rejects.toThrow();
      else {
        const response = await buyer.fetch(f.url);
        expect(response.status).toBe(outcome === 'error' ? 500 : outcome === 'repeat' ? 402 : 401);
        await response.text();
      }
      expect(f.platform).toHaveBeenCalledTimes(1);
      expect(f.payments).toEqual(['first']);
      expect(f.paths).toHaveLength(2);
      if (outcome === 'error' || outcome === 'disconnect') {
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(Errors.PaymentOutcomeUnknownError);
        const failure = failures[0];
        if (!(failure instanceof Errors.PaymentOutcomeUnknownError)) throw new Error('Expected an uncertain outcome');
        expect(failure.challenge.id).toBe('first');
        expect(decodeCredential(failure.credential.replace(/^Payment /u, '')).challenge.id).toBe('first');
      }
    } finally {
      await f.close();
    }
  },
);

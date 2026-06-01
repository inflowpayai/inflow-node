import { encode, encodeCredential } from '@inflowpayai/mpp';
import type { InflowClientOptions, MppChallenge, MppCredential } from '@inflowpayai/mpp';
import { Credential } from 'mppx';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  MppMalformedCredentialError,
  MppPaymentCancelledError,
  MppPaymentExpiredError,
  MppPaymentFailedError,
  MppPaymentTimeoutError,
} from '../../src/errors.js';
import { createFulfiller } from '../../src/fulfilment.js';
import { inflow } from '../../src/methods.client.js';

const BASE = 'https://mpp.test';
const RECIPIENT = '00000000-0000-0000-0000-000000000001';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A parsed `mppx` challenge as `createCredential` receives it (`request` is the decoded object). */
function challenge() {
  return {
    id: 'chal-abc',
    realm: 'mpp.test',
    method: 'inflow' as const,
    intent: 'charge' as const,
    request: { amount: '10', currency: 'USDC', recipient: RECIPIENT, methodDetails: { rail: 'balance' as const } },
    expires: '2999-01-01T00:00:00Z',
  };
}

/** A minimal server-produced credential, base64url-encoded as the server returns it on `ready`. */
function serverCredential(payload: Record<string, unknown>, source: string): string {
  const embedded: MppChallenge = {
    id: 'chal-abc',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: 'eyJhbW91bnQiOiIxMCJ9',
  };
  const credential: MppCredential = { challenge: embedded, payload, source };
  return encodeCredential(credential);
}

function method(overrides: Partial<InflowClientOptions & { pollIntervalMs?: number; timeoutMs?: number }> = {}) {
  return inflow({ apiKey: 'test-key', baseUrl: BASE, ...overrides });
}

describe('fulfilment lifecycle', () => {
  it('returns the server credential on a ready-on-create response, forwarding source + payload verbatim', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({
          state: 'ready',
          credential: serverCredential({ transactionId: 'tx-1', approvalId: 'ap-1' }, 'did:inflow:payer-1'),
          expires: '2999-01-01T00:00:00Z',
        }),
      ),
    );

    const auth = await method().createCredential({ challenge: challenge(), context: {} });

    expect(auth).toMatch(/^Payment\s+/);
    const back = Credential.deserialize(auth);
    expect((back.payload as Record<string, unknown>).transactionId).toBe('tx-1');
    expect(back.source).toBe('did:inflow:payer-1');
  });

  it('authenticates with a device-flow access token (Authorization: Bearer) when getAccessToken is supplied', async () => {
    let authHeader: string | null = null;
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, ({ request }) => {
        authHeader = request.headers.get('authorization');
        return HttpResponse.json({
          state: 'ready',
          credential: serverCredential({ transactionId: 'tx-bearer' }, 'did:inflow:payer-b'),
        });
      }),
    );

    const auth = await inflow({
      getAccessToken: () => Promise.resolve('device-token'),
      baseUrl: BASE,
    }).createCredential({
      challenge: challenge(),
      context: {},
    });

    expect(authHeader).toBe('Bearer device-token');
    expect(Credential.deserialize(auth).source).toBe('did:inflow:payer-b');
  });

  it('serializes a ready credential that carries no source (source omitted from the wire value)', async () => {
    // A credential object without `source` — the buyer must not synthesise one.
    const noSource = encode({
      challenge: { id: 'chal-abc', realm: 'mpp.test', method: 'inflow', intent: 'charge', request: 'eyJ9' },
      payload: { transactionId: 'tx-ns' },
    });
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () => HttpResponse.json({ state: 'ready', credential: noSource })),
    );

    const auth = await method().createCredential({ challenge: challenge(), context: {} });

    expect(auth).toMatch(/^Payment\s+/);
    expect(Credential.deserialize(auth).source).toBeUndefined();
  });

  it('polls pending → ready, honouring retryAfterSeconds, then returns the credential', async () => {
    let posts = 0;
    let gets = 0;
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () => {
        posts += 1;
        return HttpResponse.json({ state: 'pending', transactionId: 'tx-2', approvalId: 'ap-2', retryAfterSeconds: 0 });
      }),
      http.get(`${BASE}/v1/transactions/tx-2/mpp`, () => {
        gets += 1;
        if (gets < 2) {
          return HttpResponse.json({
            state: 'pending',
            transactionId: 'tx-2',
            approvalId: 'ap-2',
            retryAfterSeconds: 0,
          });
        }
        return HttpResponse.json({
          state: 'ready',
          credential: serverCredential({ transactionId: 'tx-2' }, 'did:inflow:payer-2'),
        });
      }),
    );

    const auth = await method().createCredential({ challenge: challenge(), context: {} });

    expect(posts).toBe(1);
    expect(gets).toBeGreaterThanOrEqual(2);
    expect(Credential.deserialize(auth).source).toBe('did:inflow:payer-2');
  });

  it('throws MppPaymentFailedError carrying the problem on a failed-on-create response', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({
          state: 'failed',
          transactionId: 'tx-3',
          problem: {
            type: 'https://paymentauth.org/problems/verification-failed',
            title: 'Verification failed',
            status: 402,
            detail: 'no funds',
          },
        }),
      ),
    );

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppPaymentFailedError,
    );
  });

  it('fire-and-forget cancels the backing approval when a pending transaction then fails', async () => {
    let cancelHit = false;
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-3b', approvalId: 'ap-3b', retryAfterSeconds: 0 }),
      ),
      http.get(`${BASE}/v1/transactions/tx-3b/mpp`, () =>
        HttpResponse.json({
          state: 'failed',
          transactionId: 'tx-3b',
          problem: {
            type: 'https://paymentauth.org/problems/verification-failed',
            title: 'Verification failed',
            status: 402,
            detail: 'declined',
          },
        }),
      ),
      http.post(`${BASE}/v1/approvals/ap-3b/cancel`, () => {
        cancelHit = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppPaymentFailedError,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelHit).toBe(true);
  });

  it('throws MppPaymentExpiredError when the transaction expires while polling', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-4', approvalId: 'ap-4', retryAfterSeconds: 0 }),
      ),
      http.get(`${BASE}/v1/transactions/tx-4/mpp`, () => HttpResponse.json({ state: 'expired' })),
      http.post(`${BASE}/v1/approvals/ap-4/cancel`, () => new HttpResponse(null, { status: 204 })),
    );

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppPaymentExpiredError,
    );
  });

  it('throws MppMalformedCredentialError when a ready response carries no credential', async () => {
    server.use(http.post(`${BASE}/v1/transactions/mpp`, () => HttpResponse.json({ state: 'ready' })));

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppMalformedCredentialError,
    );
  });

  it('cleanup() aborts an in-flight poll, rejecting with MppPaymentCancelledError', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-5', approvalId: 'ap-5', retryAfterSeconds: 1 }),
      ),
      http.get(`${BASE}/v1/transactions/tx-5/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-5', approvalId: 'ap-5', retryAfterSeconds: 1 }),
      ),
      http.post(`${BASE}/v1/approvals/ap-5/cancel`, () => new HttpResponse(null, { status: 204 })),
    );

    const m = method();
    const promise = m.createCredential({ challenge: challenge(), context: {} });
    await new Promise((r) => setTimeout(r, 30));
    m.cleanup();

    await expect(promise).rejects.toBeInstanceOf(MppPaymentCancelledError);
  });

  it('throws MppPaymentTimeoutError when the budget elapses before ready', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-7', approvalId: 'ap-7', retryAfterSeconds: 0 }),
      ),
      http.get(`${BASE}/v1/transactions/tx-7/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-7', approvalId: 'ap-7', retryAfterSeconds: 0 }),
      ),
      http.post(`${BASE}/v1/approvals/ap-7/cancel`, () => new HttpResponse(null, { status: 204 })),
    );

    await expect(
      method({ timeoutMs: 1 }).createCredential({ challenge: challenge(), context: {} }),
    ).rejects.toBeInstanceOf(MppPaymentTimeoutError);
  });

  it('throws MppMalformedCredentialError when the ready credential cannot be decoded', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'ready', credential: 'not%%valid%%base64url' }),
      ),
    );

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppMalformedCredentialError,
    );
  });

  it('throws MppMalformedCredentialError when a pending response carries no transactionId', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', approvalId: 'ap-8', retryAfterSeconds: 0 }),
      ),
      http.post(`${BASE}/v1/approvals/ap-8/cancel`, () => new HttpResponse(null, { status: 204 })),
    );

    await expect(method().createCredential({ challenge: challenge(), context: {} })).rejects.toBeInstanceOf(
      MppMalformedCredentialError,
    );
  });

  it('aborts via a caller-supplied signal, rejecting with MppPaymentCancelledError', async () => {
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-9', approvalId: 'ap-9', retryAfterSeconds: 1 }),
      ),
      http.get(`${BASE}/v1/transactions/tx-9/mpp`, () =>
        HttpResponse.json({ state: 'pending', transactionId: 'tx-9', approvalId: 'ap-9', retryAfterSeconds: 1 }),
      ),
      http.post(`${BASE}/v1/approvals/ap-9/cancel`, () => new HttpResponse(null, { status: 204 })),
    );

    const fulfiller = createFulfiller({ apiKey: 'k', baseUrl: BASE });
    const ac = new AbortController();
    const promise = fulfiller.fulfil(challenge(), {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);

    await expect(promise).rejects.toBeInstanceOf(MppPaymentCancelledError);
  });

  it('cancelApproval never rejects on a server-side outcome', async () => {
    server.use(
      http.post(`${BASE}/v1/approvals/ap-6/cancel`, () =>
        HttpResponse.json(
          {
            type: 'https://paymentauth.org/problems/invalid-challenge',
            title: 'Already terminal',
            status: 409,
            detail: 'gone',
          },
          { status: 409 },
        ),
      ),
    );

    await expect(method().cancelApproval('ap-6')).resolves.toBeUndefined();
  });
});

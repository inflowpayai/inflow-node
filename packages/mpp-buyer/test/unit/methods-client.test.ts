import { encodeCredential } from '@inflowpayai/mpp';
import type { MppChallenge, MppCredential } from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { inflow, inflowContextSchema, tempo, tempoContextSchema } from '../../src/methods.client.js';

const BASE = 'https://mpp.test';
const UUID = '00000000-0000-0000-0000-0000000000aa';
const TEMPO_ASSET = '0x20c0000000000000000000000000000000000000';
const TEMPO_RECIPIENT = '0x2222222222222222222222222222222222222222';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function challenge() {
  return {
    id: 'chal-abc',
    realm: 'mpp.test',
    method: 'inflow' as const,
    intent: 'charge' as const,
    request: { amount: '10', currency: 'USD', recipient: UUID, methodDetails: { rail: 'instrument' as const } },
  };
}

function tempoChallenge() {
  return {
    id: 'tempo-chal-abc',
    realm: 'mpp.test',
    method: 'tempo' as const,
    intent: 'charge' as const,
    request: {
      amount: '100',
      currency: TEMPO_ASSET,
      recipient: TEMPO_RECIPIENT,
      methodDetails: { chainId: 555555555, supportedModes: ['pull'] as ('pull' | 'push')[] },
    },
  };
}

function readyCredential(method: 'inflow' | 'tempo' = 'inflow'): string {
  const embedded: MppChallenge = {
    id: 'chal-abc',
    realm: 'mpp.test',
    method,
    intent: 'charge',
    request: 'eyJ9',
  };
  const credential: MppCredential = {
    challenge: embedded,
    payload: { transactionId: 'tx-x', type: method === 'tempo' ? 'transaction' : 'balance' },
    source: method === 'tempo' ? 'did:pkh:eip155:555555555:0x4444444444444444444444444444444444444444' : 'did:inflow:p',
  };
  return encodeCredential(credential);
}

describe('inflow context schema', () => {
  it('accepts an empty context', () => {
    expect(inflowContextSchema.parse({})).toEqual({});
  });

  it('accepts a valid instrumentId', () => {
    expect(inflowContextSchema.parse({ instrumentId: UUID })).toEqual({ instrumentId: UUID });
  });

  it('rejects a non-UUID instrumentId', () => {
    expect(() => inflowContextSchema.parse({ instrumentId: 'not-a-uuid' })).toThrow();
  });
});

describe('inflow method', () => {
  it('forwards the context instrumentId as the InFlow payment options', async () => {
    let sentOptions: unknown;
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, async ({ request }) => {
        const body = (await request.json()) as { options?: unknown };
        sentOptions = body.options;
        return HttpResponse.json({ state: 'ready', credential: readyCredential() });
      }),
    );

    await inflow({ apiKey: 'k', baseUrl: BASE }).createCredential({
      challenge: challenge(),
      context: { instrumentId: UUID },
    });

    expect(sentOptions).toEqual({ instrumentId: UUID });
  });

  it('exposes cleanup() and cancelApproval() on the method', () => {
    const m = inflow({ apiKey: 'k', baseUrl: BASE });
    expect(typeof m.cleanup).toBe('function');
    expect(typeof m.cancelApproval).toBe('function');
  });
});

describe('tempo context schema', () => {
  it('accepts an empty context', () => {
    expect(tempoContextSchema.parse({})).toEqual({});
  });
});

describe('tempo method', () => {
  it('forwards a Tempo challenge with empty options and returns the server credential', async () => {
    let sentBody: unknown;
    server.use(
      http.post(`${BASE}/v1/transactions/mpp`, async ({ request }) => {
        sentBody = await request.json();
        return HttpResponse.json({ state: 'ready', credential: readyCredential('tempo') });
      }),
    );

    const authorization = await tempo({ apiKey: 'k', baseUrl: BASE }).createCredential({
      challenge: tempoChallenge(),
      context: {},
    });

    const body = sentBody as { challenge: { method: string; request: string }; options?: Record<string, unknown> };
    expect(body.challenge.method).toBe('tempo');
    expect(body.options).toEqual({});
    expect(authorization).toMatch(/^Payment\s+/);
  });

  it('cleanup() aborts in-flight polls and cancelApproval() POSTs the cancel endpoint', async () => {
    let cancelUrl: string | undefined;
    server.use(
      http.post(`${BASE}/v1/approvals/:approvalId/cancel`, ({ request }) => {
        cancelUrl = request.url;
        return HttpResponse.json({});
      }),
    );

    const m = tempo({ apiKey: 'k', baseUrl: BASE });
    // With no in-flight poll, cleanup() is a no-op, but it still exercises the delegation to the fulfiller.
    expect(m.cleanup()).toBeUndefined();
    await expect(m.cancelApproval('approval-xyz')).resolves.toBeUndefined();
    expect(cancelUrl).toContain('/v1/approvals/approval-xyz/cancel');
  });
});

import { encodeCredential } from '@inflowpayai/mpp';
import type { MppChallenge, MppCredential } from '@inflowpayai/mpp';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { inflow, inflowContextSchema } from '../../src/methods.client.js';

const BASE = 'https://mpp.test';
const UUID = '00000000-0000-0000-0000-0000000000aa';
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

function readyCredential(): string {
  const embedded: MppChallenge = {
    id: 'chal-abc',
    realm: 'mpp.test',
    method: 'inflow',
    intent: 'charge',
    request: 'eyJ9',
  };
  const credential: MppCredential = { challenge: embedded, payload: { transactionId: 'tx-x' }, source: 'did:inflow:p' };
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

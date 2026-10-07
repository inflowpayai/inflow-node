import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { decodeCredential, encode, encodeCredential, MppClient, renderChallengeHeader } from '@inflowpayai/mpp';
import type { CardChargeRequest, CardPaymentOptions } from '@inflowpayai/mpp';
import { expect, it, vi } from 'vitest';

import { card, cardContextSchema, Mppx, MppPaymentCancelledError, MppPaymentFailedError } from '../../src/index.js';

const request: CardChargeRequest = {
  amount: '100',
  currency: 'usd',
  recipient: 'external-merchant',
  methodDetails: {
    acceptedNetworks: ['visa'],
    merchantName: 'External Seller',
    encryptionJwk: { kty: 'RSA', alg: 'RSA-OAEP-256', use: 'enc', kid: 'seller-key', n: 'public-modulus', e: 'AQAB' },
  },
};
const challenge = {
  id: 'card-purchase',
  realm: 'seller.example',
  method: 'card' as const,
  intent: 'charge' as const,
  request: encode(request),
  expires: '2099-01-01T00:00:00Z',
  description: 'A report',
  digest: 'sha-256=bound-request',
  opaque: encode({ product: 'report' }),
};
const payload = {
  encryptedPayload: 'opaque-ciphertext-never-decrypted-by-buyer',
  network: 'visa',
  panLastFour: '4242',
  panExpirationMonth: '06',
  panExpirationYear: '2028',
  billingAddress: { line1: '10 Market St', zip: '94102', countryCode: 'US' },
  extension: 'preserve-provider-extension',
};
const credential = { challenge, payload, source: 'did:inflow:buyer' };
const options: CardPaymentOptions = Object.freeze({
  merchant: Object.freeze({ name: 'External Seller', url: 'https://seller.example', countryCode: 'US' }),
});

it.each([
  'primary',
  'selected',
  'bearer',
  'missing-context',
  'invalid-context',
  'unsupported',
  'failed',
  'unknown',
  'expired',
  'mismatch',
  'mismatch-amount',
  'mismatch-recipient',
  'mismatch-key',
  'mismatch-opaque',
  'invalid-payload',
  'rejected',
  'cancel',
] as const)('drives CARD through the real HTTP transport: %s', async (scenario) => {
  const paths: string[] = [];
  const failures: unknown[] = [];
  let polling = false;
  const selectedOptions =
    scenario === 'selected' ? { ...options, instrumentId: '00000000-0000-4000-8000-000000000001' } : options;
  const advertised =
    scenario === 'unsupported' ? { ...challenge, request: encode({ ...request, currency: 'eur' }) } : challenge;
  const problem = {
    type: scenario === 'unknown' ? 'settlement-unavailable' : 'verification-failed',
    title: 'Payment unavailable',
    status: 402,
    detail: scenario === 'unknown' ? 'Issuance outcome unknown; do not start another payment.' : 'Payment declined.',
  };
  const server = createServer((incoming, response) => {
    void (async () => {
      const path = incoming.url ?? '';
      paths.push(path);
      response.setHeader('Content-Type', 'application/json');
      if (path === '/paid') {
        expect(incoming.headers['x-api-key']).toBeUndefined();
        if (incoming.headers.authorization === undefined) {
          response.writeHead(402, { 'WWW-Authenticate': renderChallengeHeader(advertised) }).end('{}');
        } else {
          expect(decodeCredential(incoming.headers.authorization.slice('Payment '.length))).toEqual(credential);
          if (scenario === 'rejected') {
            response.writeHead(402, { 'WWW-Authenticate': renderChallengeHeader(advertised) }).end('{}');
          } else response.end('{"paid":true}');
        }
        return;
      }
      expect(incoming.headers[scenario === 'bearer' ? 'authorization' : 'x-api-key']).toBe(
        scenario === 'bearer' ? 'Bearer synthetic-token' : 'synthetic-key',
      );
      if (path === '/v1/transactions/mpp-supported') {
        expect(incoming.method).toBe('GET');
        response.end(JSON.stringify({ kinds: [{ method: 'card', intents: [{ intent: 'charge', rails: [] }] }] }));
      } else if (path === '/v1/transactions/mpp') {
        expect(incoming.method).toBe('POST');
        expect(JSON.parse(await text(incoming))).toEqual({ challenge, options: selectedOptions });
        response.end(
          JSON.stringify({
            state: 'pending',
            transactionId: 'transaction',
            approvalId: 'approval',
            retryAfterSeconds: 0,
          }),
        );
      } else if (path === '/v1/transactions/transaction/mpp') {
        polling = true;
        if (scenario === 'cancel') {
          response.write('{"state":');
          return;
        }
        if (scenario === 'failed' || scenario === 'unknown') {
          response.end(JSON.stringify({ state: 'failed', transactionId: 'transaction', problem }));
        } else if (scenario === 'expired') {
          response.end(JSON.stringify({ state: 'expired', transactionId: 'transaction' }));
        } else {
          response.end(
            JSON.stringify({
              state: 'ready',
              transactionId: 'transaction',
              credential: encodeCredential({
                ...credential,
                ...(scenario === 'mismatch' ? { challenge: { ...challenge, id: 'other-purchase' } } : {}),
                ...(scenario === 'mismatch-amount'
                  ? { challenge: { ...challenge, request: encode({ ...request, amount: '200' }) } }
                  : {}),
                ...(scenario === 'mismatch-recipient'
                  ? { challenge: { ...challenge, request: encode({ ...request, recipient: 'another-merchant' }) } }
                  : {}),
                ...(scenario === 'mismatch-key'
                  ? {
                      challenge: {
                        ...challenge,
                        request: encode({
                          ...request,
                          methodDetails: {
                            ...request.methodDetails,
                            encryptionJwk: { ...request.methodDetails.encryptionJwk, kid: 'other-key' },
                          },
                        }),
                      },
                    }
                  : {}),
                ...(scenario === 'mismatch-opaque'
                  ? { challenge: { ...challenge, opaque: encode({ product: 'other' }) } }
                  : {}),
                ...(scenario === 'invalid-payload' ? { payload: { ...payload, encryptedPayload: '' } } : {}),
              }),
            }),
          );
        }
      } else if (path === '/v1/approvals/approval/cancel') {
        expect(incoming.method).toBe('POST');
        response.writeHead(scenario === 'cancel' ? 204 : 404).end();
      } else response.writeHead(404).end();
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const parameters = {
    baseUrl,
    timeoutMs: 2000,
    ...(scenario === 'bearer' ? { getAccessToken: () => 'synthetic-token' } : { apiKey: 'synthetic-key' }),
  };
  const method = card(parameters);
  const client = Mppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 1 });
  try {
    const supported = await new MppClient(parameters).getSupported();
    expect(
      supported.kinds.some(
        (kind) => kind.method === 'card' && kind.intents.some((intent) => intent.intent === 'charge'),
      ),
    ).toBe(true);
    const result = client
      .fetch(`${baseUrl}/paid`, {
        ...(scenario === 'missing-context'
          ? {}
          : {
              context:
                scenario === 'invalid-context'
                  ? { merchant: { ...options.merchant, url: 'not-a-url' } }
                  : selectedOptions,
            }),
      })
      .catch((error: unknown) => error);
    if (scenario === 'cancel') {
      await vi.waitFor(() => expect(polling).toBe(true));
      method.cleanup();
    }
    const outcome = await result;
    if (['primary', 'selected', 'bearer', 'rejected'].includes(scenario)) {
      expect(outcome).toBeInstanceOf(Response);
      if (!(outcome instanceof Response)) throw new Error('Expected a response');
      expect(outcome.status).toBe(scenario === 'rejected' ? 402 : 200);
      expect(paths.filter((path) => path === '/v1/transactions/mpp')).toHaveLength(1);
      expect(paths.filter((path) => path === '/paid')).toHaveLength(2);
      // Owner-scoped polling recovers the saved credential without creating another purchase.
      const recovered = await new MppClient(parameters).getTransaction('transaction');
      expect(recovered.credential).toBe(encodeCredential(credential));
    } else {
      expect(outcome).toBeInstanceOf(Error);
      if (scenario.startsWith('mismatch') || scenario === 'invalid-payload') {
        expect(outcome).toMatchObject({ name: 'MppMalformedCredentialError' });
      }
      if (scenario === 'failed' || scenario === 'unknown') {
        expect(outcome).toBeInstanceOf(MppPaymentFailedError);
        expect(outcome).toMatchObject({ problem, transactionId: 'transaction', message: problem.detail });
      }
      if (scenario === 'cancel') expect(outcome).toBeInstanceOf(MppPaymentCancelledError);
      if (['failed', 'unknown', 'expired', 'cancel'].includes(scenario)) {
        await vi.waitFor(() => expect(paths).toContain('/v1/approvals/approval/cancel'));
      }
      expect(paths.filter((path) => path === '/paid')).toHaveLength(1);
      expect(paths.filter((path) => path === '/v1/transactions/mpp')).toHaveLength(
        ['missing-context', 'invalid-context', 'unsupported'].includes(scenario) ? 0 : 1,
      );
    }
    await method.cancelApproval('approval');
    expect(failures).toEqual([]);
  } finally {
    method.cleanup();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

it('validates direct CARD calls and does not change the caller context', async () => {
  const method = card({ apiKey: 'synthetic-key', baseUrl: 'http://127.0.0.1:1' });
  expect(cardContextSchema.parse(options)).toEqual(options);
  await expect(
    method.createCredential({ challenge: { ...challenge, request: { ...request, amount: '1' } }, context: options }),
  ).rejects.toThrow();
});

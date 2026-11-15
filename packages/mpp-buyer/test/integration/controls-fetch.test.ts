import { once } from 'node:events';
import { createServer } from 'node:http';
import { encode, encodeCredential, renderChallengeHeader } from '@inflowpayai/mpp';
import { expect, it, vi } from 'vitest';

import { card, inflow, Mppx, tempo } from '../../src/index.js';

it.each([
  ['inflow', 'permitted'],
  ['inflow', 'rejected'],
  ['inflow', 'default'],
  ['tempo', 'permitted'],
  ['tempo', 'rejected'],
  ['tempo', 'default'],
] as const)('enforces %s limits through real MPP fetch: %s', async (kind, scenario) => {
  const paths: string[] = [];
  const challenge = {
    id: 'limit-test',
    realm: 'seller.test',
    method: kind,
    intent: 'charge',
    request: encode(
      kind === 'inflow'
        ? { amount: '1.01', currency: 'USD' }
        : {
            amount: '1010000',
            currency: '0x1111111111111111111111111111111111111111',
            methodDetails: { chainId: 4217 },
          },
    ),
  };
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    paths.push(path);
    if (path === '/paid' && request.headers.authorization === undefined) {
      response.writeHead(402, { 'WWW-Authenticate': renderChallengeHeader(challenge) }).end('{}');
    } else if (path === '/v1/transactions/mpp') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          state: 'ready',
          credential: encodeCredential({
            challenge,
            source: 'did:inflow:synthetic',
            payload: { transactionId: 'synthetic' },
          }),
        }),
      );
    } else {
      response.end('paid');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const method =
    kind === 'inflow'
      ? inflow({
          apiKey: 'synthetic',
          baseUrl,
          ...(scenario === 'default'
            ? {}
            : {
                currencies: ['USD'],
                maxAmount: scenario === 'permitted' ? '1.01' : '1.00',
              }),
        })
      : tempo({
          apiKey: 'synthetic',
          baseUrl,
          ...(scenario === 'default'
            ? {}
            : {
                currencies: ['0x1111111111111111111111111111111111111111'],
                decimals: 6,
                maxAmount: scenario === 'permitted' ? '1.01' : '1.00',
                allowedChainIds: [4217],
              }),
        });
  const client = Mppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 1 });
  try {
    if (scenario === 'rejected') {
      await expect(client.fetch(`${baseUrl}/paid`)).rejects.toThrow();
      expect(paths).toEqual(['/paid']);
    } else {
      expect(await (await client.fetch(`${baseUrl}/paid`)).text()).toBe('paid');
      expect(paths).toEqual(['/paid', '/v1/transactions/mpp', '/paid']);
    }
  } finally {
    method.cleanup();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

it('rejects direct credential calls before requesting approval', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const method = inflow({ apiKey: 'synthetic', fetch, currencies: ['USD'], maxAmount: '1' });
  await expect(
    method.createCredential({
      challenge: {
        id: 'direct',
        realm: 'seller.test',
        method: 'inflow',
        intent: 'charge',
        request: { amount: '1.01', currency: 'USD' },
      },
      context: {},
    }),
  ).rejects.toThrow('maxAmount');
  const tempoMethod = tempo({ apiKey: 'synthetic', fetch, allowedChainIds: [4217] });
  await expect(
    tempoMethod.createCredential({
      challenge: {
        id: 'direct',
        realm: 'seller.test',
        method: 'tempo',
        intent: 'charge',
        request: { amount: '100', methodDetails: { chainId: 1 } },
      },
      context: {},
    }),
  ).rejects.toThrow('chain');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['limit', 'cancel'] as const)('rejects CARD %s before requesting a credential', async (reason) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const method = card({ apiKey: 'synthetic', fetch, maxAmount: reason === 'limit' ? '1' : '2' });
  const controller = new AbortController();
  controller.abort();
  const challenge = {
    id: 'card-limit',
    realm: 'seller.test',
    method: 'card' as const,
    intent: 'charge' as const,
    request: {
      amount: '101',
      currency: 'usd' as const,
      recipient: 'seller',
      methodDetails: {
        acceptedNetworks: ['visa' as const],
        merchantName: 'Seller',
        encryptionJwk: {
          kty: 'RSA' as const,
          alg: 'RSA-OAEP-256' as const,
          use: 'enc' as const,
          kid: 'key',
          n: 'modulus',
          e: 'AQAB',
        },
      },
    },
  };
  expect(method.canHandleChallenge?.({ challenge })).toBe(reason === 'cancel');
  await expect(
    method.createCredential({
      challenge,
      context: {
        merchant: { name: 'Seller', url: 'https://seller.test', countryCode: 'US' },
        ...(reason === 'cancel' ? { signal: controller.signal } : {}),
      },
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

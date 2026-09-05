import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AEP_GRANT_TYPE_API_KEY, didWebDocumentUrl, validateInspectDocument } from '@aep-foundation/core';
import { createInMemoryServiceCredentialStore } from '@aep-foundation/service';
import { decode, parseChallengeHeader } from '@inflowpayai/mpp';
import type { MppCredential } from '@inflowpayai/mpp';
import express from 'express';
import { Credential } from 'mppx';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMppAepSellerApp } from '../src/app.js';

const servers: Server[] = [];
const apiKey = 'aep-api-key';

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('sequential AEP and MPP enforcement', () => {
  it('enforces AEP before MPP, completes GET and POST with both credentials, and keeps credentials out of logs', async () => {
    const requestLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fixture = await startFixture();
    try {
      const anonymous = await fetch(`${fixture.url}/api/widgets`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toMatch(/^AEP /);
      expect(anonymous.headers.get('www-authenticate')).not.toContain('Payment');
      expect(fixture.broadcastCalls).toBe(0);
      expect(fixture.validateCalls).toBe(0);
      expect(fixture.aepPassed).toBe(0);
      expect(fixture.handlerRequests).toHaveLength(0);

      const free = await fetch(`${fixture.url}/free`);
      expect(free.status).toBe(200);
      expect(fixture.broadcastCalls).toBe(0);
      expect(fixture.validateCalls).toBe(0);
      expect(fixture.aepPassed).toBe(0);

      const inspectResponse = await fetch(`${fixture.url}/.well-known/aep`);
      const inspect = validateInspectDocument(await inspectResponse.json());
      expect(inspect.ok).toBe(true);
      if (!inspect.ok) throw new Error('The example emitted an invalid AEP Inspect document.');
      expect(didWebDocumentUrl(inspect.value.service.did).origin).toBe(fixture.url);
      const didResponse = await fetch(didWebDocumentUrl(inspect.value.service.did));
      await expect(didResponse.json()).resolves.toEqual({ id: inspect.value.service.did });

      const openApiResponse = await fetch(`${fixture.url}/openapi.json`);
      await expect(openApiResponse.json()).resolves.toMatchObject({
        paths: {
          '/api/subscribe': { get: { security: [{ aepApiKey: [] }] } },
          '/api/upload': { post: { security: [{ aepApiKey: [] }] } },
          '/api/widgets': { get: { security: [{ aepApiKey: [] }] } },
        },
      });

      const paymentRequired = await fetch(`${fixture.url}/api/widgets`, {
        headers: { 'x-aep-api-key': apiKey },
      });
      expect(paymentRequired.status).toBe(402);
      expect(paymentRequired.headers.get('www-authenticate')).toMatch(/^Payment /);
      expect(paymentRequired.headers.get('www-authenticate')).not.toContain('AEP ');
      expect(fixture.aepPassed).toBe(1);
      expect(fixture.handlerRequests).toHaveLength(0);

      const rejectedPayment = await fetch(`${fixture.url}/api/widgets`, {
        headers: {
          authorization: paymentAuthorization(paymentRequired),
          'x-aep-api-key': apiKey,
        },
      });
      expect(rejectedPayment.status).toBe(402);
      expect(fixture.broadcastCalls).toBe(1);
      expect(fixture.validateCalls).toBe(1);
      expect(fixture.handlerRequests).toHaveLength(0);

      fixture.broadcastOutcome = 'success';
      const getChallenge = await fetch(`${fixture.url}/api/widgets`, { headers: { 'x-aep-api-key': apiKey } });
      const getAuthorization = paymentAuthorization(getChallenge);
      const getResponse = await fetch(`${fixture.url}/api/widgets`, {
        headers: { authorization: getAuthorization, 'x-aep-api-key': apiKey },
      });
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual({ widgets: [1, 2, 3] });

      const body = '{"widget":"one","nested":{"preserved":true}}';
      const callerHeader = 'retained-through-payment-replay';
      const postChallenge = await fetch(`${fixture.url}/api/upload`, {
        body,
        headers: { 'content-type': 'application/json', 'x-aep-api-key': apiKey, 'x-caller-header': callerHeader },
        method: 'POST',
      });
      const postResponse = await fetch(`${fixture.url}/api/upload`, {
        body,
        headers: {
          authorization: paymentAuthorization(postChallenge),
          'content-type': 'application/json',
          'x-aep-api-key': apiKey,
          'x-caller-header': callerHeader,
        },
        method: 'POST',
      });
      expect(postResponse.status).toBe(200);
      expect(await postResponse.json()).toEqual({ received: JSON.parse(body) });
      expect(fixture.handlerRequests).toHaveLength(2);
      expect(fixture.handlerRequests[1]).toMatchObject({
        authorization: expect.stringMatching(/^Payment /),
        'x-aep-api-key': apiKey,
        'x-caller-header': callerHeader,
      });
      expect(fixture.configCalls).toBeGreaterThan(0);
      expect(fixture.broadcastCalls).toBe(3);
      expect(fixture.validateCalls).toBe(3);
      expect(requestLog.mock.calls.flat().join(' ')).not.toContain(apiKey);
      expect(requestLog.mock.calls.flat().join(' ')).not.toContain(getAuthorization);
    } finally {
      requestLog.mockRestore();
    }
  });

  it('accepts a subscription credential once and rejects a replay of the same credential', async () => {
    const fixture = await startFixture();
    fixture.broadcastOutcome = 'success';

    const challenge = await fetch(`${fixture.url}/api/subscribe`, {
      headers: { 'x-aep-api-key': apiKey },
    });
    expect(challenge.status).toBe(402);

    const authorization = paymentAuthorization(challenge);
    const first = await fetch(`${fixture.url}/api/subscribe`, {
      headers: {
        authorization,
        'x-aep-api-key': apiKey,
      },
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ subscribed: true });

    const replay = await fetch(`${fixture.url}/api/subscribe`, {
      headers: {
        authorization,
        'x-aep-api-key': apiKey,
      },
    });
    expect(replay.status).toBe(402);
    await expect(replay.json()).resolves.toMatchObject({
      detail: 'The subscription authorization has already been consumed.',
      status: 402,
      title: 'Verification Failed',
      type: 'https://paymentauth.org/problems/verification-failed',
    });

    expect(fixture.broadcastCalls).toBe(2);
    expect(fixture.broadcastIdempotencyKeys).toHaveLength(2);
    expect(fixture.broadcastIdempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.broadcastIdempotencyKeys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.broadcastIdempotencyKeys[1]).not.toBe(fixture.broadcastIdempotencyKeys[0]);
    expect(fixture.handlerRequests).toHaveLength(1);
    expect(fixture.validateCalls).toBe(2);
  });
});

async function startFixture() {
  let configCalls = 0;
  let broadcastCalls = 0;
  const broadcastIdempotencyKeys: Array<string | null> = [];
  let broadcastOutcome: 'problem' | 'success' = 'problem';
  const consumedCredentials = new Set<string>();
  let validateCalls = 0;
  let aepPassed = 0;
  const handlerRequests: Record<string, string | undefined>[] = [];
  const credentialStore = createInMemoryServiceCredentialStore();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await credentialStore.saveCredential({
    agentDid: 'did:web:agent.example',
    createdAt: new Date().toISOString(),
    credential: {
      api_key: apiKey,
      credential_id: 'credential-1',
      expires_at: expiresAt,
      header: 'x-aep-api-key',
      scopes: ['read:widgets', 'write:uploads'],
    },
    credentialId: 'credential-1',
    expiresAt,
    grantType: AEP_GRANT_TYPE_API_KEY,
  });
  const configApp = express();
  configApp.use(express.json());
  configApp.get('/v1/mpp/config', (_request, response) => {
    configCalls += 1;
    response.json(configResponse());
  });
  configApp.post('/v1/mpp/validate', (request, response) => {
    validateCalls += 1;
    const { credential } = request.body as { credential: MppCredential };
    response.json({
      challenge: credential.challenge,
      credential,
      details: { provider: 'inflow' },
      intent: credential.challenge.intent,
      method: credential.challenge.method,
      request: decode<Record<string, unknown>>(credential.challenge.request),
      source: credential.source,
      success: true,
    });
  });
  configApp.post('/v1/mpp/broadcast', (request, response) => {
    broadcastCalls += 1;
    broadcastIdempotencyKeys.push(request.get('idempotency-key') ?? null);
    if (broadcastOutcome === 'problem') {
      response.json({
        problem: {
          detail: 'Balance too low.',
          status: 402,
          title: 'Payment Insufficient',
          type: 'https://paymentauth.org/problems/payment-insufficient',
        },
      });
      return;
    }
    const replayKey = JSON.stringify((request.body as { credential?: unknown }).credential ?? null);
    if (consumedCredentials.has(replayKey)) {
      response.json({
        problem: {
          detail: 'The subscription authorization has already been consumed.',
          status: 402,
          title: 'Verification Failed',
          type: 'https://paymentauth.org/problems/verification-failed',
        },
      });
      return;
    }
    consumedCredentials.add(replayKey);
    response.json({
      receipt: {
        challengeId: 'challenge-1',
        method: 'inflow',
        reference: 'settlement-1',
        status: 'success',
        timestamp: '2026-07-16T00:00:00.000Z',
      },
      receiptHeader: 'ignored-by-mppx',
    });
  });
  const configServer = configApp.listen(0, '127.0.0.1');
  servers.push(configServer);
  await once(configServer, 'listening');
  const configAddress = configServer.address() as AddressInfo;
  const server = createServer();
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port.toString()}`;
  const { app } = createMppAepSellerApp({
    apiKey: 'seller-api-key',
    baseUrl: `http://127.0.0.1:${configAddress.port.toString()}`,
    credentialStore,
    listenUrl: url,
    mppSecretKey: 'test-secret-key-with-at-least-thirty-two-characters',
    onAepPassed: () => {
      aepPassed += 1;
    },
    onProtectedHandler: (request) => {
      handlerRequests.push({
        authorization: request.get('authorization'),
        'x-aep-api-key': request.get('x-aep-api-key'),
        'x-caller-header': request.get('x-caller-header'),
      });
    },
  });
  server.on('request', app);

  return {
    get aepPassed() {
      return aepPassed;
    },
    get configCalls() {
      return configCalls;
    },
    get broadcastCalls() {
      return broadcastCalls;
    },
    get broadcastIdempotencyKeys() {
      return broadcastIdempotencyKeys;
    },
    get broadcastOutcome() {
      return broadcastOutcome;
    },
    set broadcastOutcome(value: 'problem' | 'success') {
      broadcastOutcome = value;
    },
    handlerRequests,
    get validateCalls() {
      return validateCalls;
    },
    url,
  };
}

function configResponse() {
  return {
    featureFlags: { idempotencyKeyEnabled: true },
    replayPolicy: { managedBy: 'psp' },
    sellerId: '22222222-2222-2222-2222-222222222222',
    supportedMethods: [
      {
        id: 'inflow',
        label: 'InFlow',
        methodDetails: { currencyRails: { USDC: { rail: 'balance' } } },
        supportedCurrencies: ['USDC'],
        supportedIntents: ['charge'],
      },
    ],
  };
}

function paymentAuthorization(response: Response): string {
  const header = response.headers.get('www-authenticate');
  if (header === null) throw new Error('missing MPP challenge');
  const challenge = parseChallengeHeader(header);
  return Credential.serialize({
    challenge: { ...challenge, request: decode(challenge.request) },
    payload: { transactionId: `transaction-${Math.random().toString()}`, type: 'balance' },
    source: 'did:inflow:payer',
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

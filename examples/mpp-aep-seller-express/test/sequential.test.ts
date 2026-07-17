import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AEP_GRANT_TYPE_API_KEY } from '@aep-foundation/core';
import { createInMemoryServiceCredentialStore } from '@aep-foundation/service';
import { decode, parseChallengeHeader } from '@inflowpayai/mpp';
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
      expect(fixture.redeemCalls).toBe(0);
      expect(fixture.aepPassed).toBe(0);
      expect(fixture.handlerRequests).toHaveLength(0);

      const free = await fetch(`${fixture.url}/free`);
      expect(free.status).toBe(200);
      expect(fixture.redeemCalls).toBe(0);
      expect(fixture.aepPassed).toBe(0);

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
      expect(fixture.redeemCalls).toBe(1);
      expect(fixture.handlerRequests).toHaveLength(0);

      fixture.redeemOutcome = 'success';
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
      expect(fixture.redeemCalls).toBe(3);
      expect(requestLog.mock.calls.flat().join(' ')).not.toContain(apiKey);
      expect(requestLog.mock.calls.flat().join(' ')).not.toContain(getAuthorization);
    } finally {
      requestLog.mockRestore();
    }
  });
});

async function startFixture() {
  let configCalls = 0;
  let redeemCalls = 0;
  let redeemOutcome: 'problem' | 'success' = 'problem';
  let aepPassed = 0;
  const handlerRequests: Record<string, string | undefined>[] = [];
  const credentialStore = createInMemoryServiceCredentialStore();
  await credentialStore.saveCredential({
    agentDid: 'did:web:agent.example',
    createdAt: new Date().toISOString(),
    credential: {
      api_key: apiKey,
      credential_id: 'credential-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      header: 'x-aep-api-key',
      scopes: ['read:widgets', 'write:uploads'],
    },
    credentialId: 'credential-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    grantType: AEP_GRANT_TYPE_API_KEY,
  });
  const configApp = express();
  configApp.use(express.json());
  configApp.get('/v1/mpp/config', (_request, response) => {
    configCalls += 1;
    response.json(configResponse());
  });
  configApp.post('/v1/mpp/redeem', (_request, response) => {
    redeemCalls += 1;
    if (redeemOutcome === 'problem') {
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
  const { app } = createMppAepSellerApp({
    apiKey: 'seller-api-key',
    baseUrl: `http://127.0.0.1:${configAddress.port.toString()}`,
    credentialStore,
    listenUrl: 'http://127.0.0.1:3000',
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
    serviceDid: 'did:web:127.0.0.1%3A4100:services:example-service',
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    get aepPassed() {
      return aepPassed;
    },
    get configCalls() {
      return configCalls;
    },
    get redeemCalls() {
      return redeemCalls;
    },
    get redeemOutcome() {
      return redeemOutcome;
    },
    set redeemOutcome(value: 'problem' | 'success') {
      redeemOutcome = value;
    },
    handlerRequests,
    url: `http://127.0.0.1:${address.port.toString()}`,
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

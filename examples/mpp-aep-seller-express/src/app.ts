import { randomUUID } from 'node:crypto';

import { AEP_GRANT_TYPE_API_KEY, didWebDocumentUrl } from '@aep-foundation/core';
import type { ApiKeyGrantResponse } from '@aep-foundation/core';
import { createExpressAepProtectedResourceHandler, registerExpressAepRoutes } from '@aep-foundation/express';
import {
  createAepService,
  createDidWebClientAssertionVerifier,
  createInMemoryClientAssertionReplayStore,
  createInMemoryCommandIdempotencyStore,
  createInMemoryEnrollmentStore,
  createInMemoryServiceCredentialStore,
  createStaticEnrollmentPolicy,
  didWebIdentityMethod,
  storedApiKeyGrantType,
} from '@aep-foundation/service';
import type { AepServiceCredentialStore } from '@aep-foundation/service';
import { inflow, inflowSubscriptionsNodeListener } from '@inflowpayai/mpp-seller';
import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Mppx } from 'mppx/express';
import { Mppx as MppxServer } from 'mppx/server';

export interface CreateMppAepSellerAppOptions {
  apiKey: string;
  baseUrl?: string;
  listenUrl: string;
  mppSecretKey: string;
  onAepPassed?: () => void;
  onProtectedHandler?: (request: Request) => void;
  credentialStore?: AepServiceCredentialStore;
}

export function createMppAepSellerApp(options: CreateMppAepSellerAppOptions) {
  const credentialStore = options.credentialStore ?? createInMemoryServiceCredentialStore();
  const serviceDid = didWebServiceDid(options.listenUrl);
  const service = createAepService({
    authenticationMethods: [AEP_GRANT_TYPE_API_KEY],
    clientAssertionVerifier: createDidWebClientAssertionVerifier(),
    commandIdempotencyStore: createInMemoryCommandIdempotencyStore(),
    enrollmentPolicy: createStaticEnrollmentPolicy(),
    enrollmentStore: createInMemoryEnrollmentStore(),
    grantTypes: [
      storedApiKeyGrantType({
        issue: (): ApiKeyGrantResponse => ({
          api_key: randomUUID(),
          credential_id: randomUUID(),
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          header: 'x-aep-api-key',
          scopes: ['read:widgets', 'write:uploads'],
        }),
        store: credentialStore,
      }),
    ],
    identityMethods: [didWebIdentityMethod()],
    openapi: { url: '/openapi.json', pathMatching: { trailingSlash: 'strict' } },
    replayStore: createInMemoryClientAssertionReplayStore(),
    serviceDid,
  });
  const method = inflow({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? { environment: 'sandbox' } : { baseUrl: options.baseUrl }),
  });
  const mppx = Mppx.create({ methods: [method], secretKey: options.mppSecretKey });
  const subscriptionMethod = inflow.subscription({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? { environment: 'sandbox' } : { baseUrl: options.baseUrl }),
  });
  const subscriptionCore = MppxServer.create({ methods: [subscriptionMethod], secretKey: options.mppSecretKey });
  const subscribe = inflowSubscriptionsNodeListener(subscriptionCore, [
    {
      amount: '1.00',
      currency: 'USDC',
      periodUnit: 'month',
      periodCount: 1,
      subscriptionExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      externalId: 'example-monthly-plan',
    },
  ]);
  const authenticateAep = createExpressAepProtectedResourceHandler(service, options.listenUrl);
  const requireAep: RequestHandler = (request, response, next) =>
    authenticateAep(request, response, () => {
      options.onAepPassed?.();
      next();
    });
  const app = express();

  app.use(express.json({ type: ['application/json', 'application/aep+json'] }));
  app.use((request, response, next) => {
    response.on('finish', () => {
      console.log(`request method=${request.method} path=${request.path} status=${response.statusCode}`);
    });
    next();
  });
  app.get(didWebDocumentUrl(serviceDid).pathname, (_request, response) => {
    response.type('application/did+json').json({ id: serviceDid });
  });
  registerExpressAepRoutes(app, service);
  app.get('/openapi.json', (_request, response) => response.json(openApiDocument()));
  app.get('/api/widgets', requireAep, mppx.charge({ amount: '0.01', currency: 'USDC' }), (request, response) => {
    options.onProtectedHandler?.(request);
    response.json({ widgets: [1, 2, 3] });
  });
  app.post('/api/upload', requireAep, mppx.charge({ amount: '0.10', currency: 'USDC' }), (request, response) => {
    options.onProtectedHandler?.(request);
    response.json({ received: request.body });
  });
  app.get('/api/subscribe', requireAep, async (request, response) => {
    const result = await subscribe(request, response);
    if (result.status === 402) return;
    options.onProtectedHandler?.(request);
    response.json({ subscribed: true });
  });
  app.get('/free', (_request, response) => {
    response.json({ ok: true, note: 'no AEP authentication or payment required' });
  });

  return { app, credentialStore, service };
}

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'AEP and MPP Express example', version: '1.0.0' },
    components: {
      securitySchemes: {
        aepApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-aep-api-key',
          'x-aep-authentication-method': AEP_GRANT_TYPE_API_KEY,
        },
      },
    },
    paths: {
      '/api/widgets': {
        get: { security: [{ aepApiKey: [] }], responses: { '200': { description: 'Paid widgets' } } },
      },
      '/api/upload': {
        post: { security: [{ aepApiKey: [] }], responses: { '200': { description: 'Paid upload' } } },
      },
      '/api/subscribe': {
        get: { security: [{ aepApiKey: [] }], responses: { '200': { description: 'Paid subscription' } } },
      },
    },
  };
}

function didWebServiceDid(url: string): string {
  const origin = new URL(url);
  return `did:web:${encodeURIComponent(origin.host)}`;
}

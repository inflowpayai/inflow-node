import { randomUUID } from 'node:crypto';

import { AEP_GRANT_TYPE_API_KEY } from '@aep-foundation/core';
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
import { inflow } from '@inflowpayai/mpp-seller';
import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Mppx } from 'mppx/express';

export interface CreateMppAepSellerAppOptions {
  apiKey: string;
  baseUrl?: string;
  listenUrl: string;
  mppSecretKey: string;
  onAepPassed?: () => void;
  onProtectedHandler?: (request: Request) => void;
  serviceDid: string;
  credentialStore?: AepServiceCredentialStore;
}

export function createMppAepSellerApp(options: CreateMppAepSellerAppOptions) {
  const credentialStore = options.credentialStore ?? createInMemoryServiceCredentialStore();
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
    serviceDid: options.serviceDid,
  });
  const method = inflow({
    apiKey: options.apiKey,
    ...(options.baseUrl === undefined ? { environment: 'sandbox' } : { baseUrl: options.baseUrl }),
  });
  const mppx = Mppx.create({ methods: [method], secretKey: options.mppSecretKey });
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
    },
  };
}

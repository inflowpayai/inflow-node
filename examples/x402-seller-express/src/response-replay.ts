import 'dotenv/config';
import { createHash } from 'node:crypto';

import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';
import { createInflowExpressReplayMiddleware } from '@inflowpayai/x402-seller/express';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/express';
import express from 'express';
import type { Request } from 'express';

import { SqliteReplayStore } from './replay-store.js';

const apiKey = process.env['INFLOW_API_KEY'];
const authenticationToken = process.env['APP_AUTH_TOKEN'];
const databaseFile = process.env['REPLAY_DATABASE'];
if (apiKey === undefined || authenticationToken === undefined || databaseFile === undefined)
  throw new Error('Set INFLOW_API_KEY, APP_AUTH_TOKEN and REPLAY_DATABASE');
const seller = await createInflowSellerClient({ apiKey, environment: 'sandbox' });
const resourceServer = new x402ResourceServer(createInflowFacilitator({ apiKey, environment: 'sandbox' }));
for (const registration of await inflowSchemeRegistrations(seller))
  resourceServer.register(registration.network, registration.server);
const httpServer = new x402HTTPResourceServer(resourceServer, {
  'POST /api/hash': { accepts: await inflowAccepts(seller, { price: '$0.01', schemes: ['exact'] }) },
});
const store = new SqliteReplayStore(databaseFile);
const principals = new WeakMap<Request, string>();
const bodies = new WeakMap<Request, Buffer>();
const app = express();
app.use((request, response, next) => {
  if (request.get('authorization') !== `Bearer ${authenticationToken}`) {
    response.status(401).end();
    return;
  }
  principals.set(request, 'example-authenticated-buyer');
  next();
});
app.use(
  express.raw({
    type: '*/*',
    inflate: false,
    limit: '1mb',
    verify(request, _response, body) {
      bodies.set(request as Request, Buffer.from(body));
    },
  }),
);
app.use(
  createInflowExpressReplayMiddleware(httpServer, {
    store,
    scope: (await seller.config()).sellerId,
    principal: (request) => principals.get(request),
    body: (request) => bodies.get(request),
    responseHeaders: ['x-product-kind'],
  }),
);
app.post('/api/hash', (request, response) => {
  response
    .status(201)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Product-Kind', 'sha256')
    .end(
      createHash('sha256')
        .update(bodies.get(request) ?? Buffer.alloc(0))
        .digest(),
    );
});
app.listen(Number(process.env['PORT'] ?? 3000));

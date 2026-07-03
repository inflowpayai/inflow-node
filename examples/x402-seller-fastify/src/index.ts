import 'dotenv/config';
import { paymentMiddlewareFromConfig } from '@x402/fastify';
import Fastify from 'fastify';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowSchemeRegistrations,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// 1. Authed InFlow facilitator — `verify`, `settle`, `getSupported`.
//    Drops into the foundation's `facilitatorClients` array. The seller
//    can prepend or append other facilitators; first claimer of a
//    (scheme, network) pair via `getSupported()` wins routing.
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });

// 2. Seller-authed client — owns `/v1/x402/config` and signer-discovery.
//    Drives `inflowAccepts`. Primes its caches in parallel at construction.
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = Fastify();

// 3. Foundation middleware + InFlow-built `PaymentOption[]` entries.
//    `@x402/fastify`'s `paymentMiddlewareFromConfig` mutates the Fastify
//    instance in place; it registers the preHandler hook and a
//    handle-404 hook for unprotected routes. `inflowAccepts` expands the
//    seller's config into AssetAmount-form `accepts[]` (atomic amount +
//    asset contract address pre-resolved). `inflowSchemeRegistrations`
//    ships passthrough scheme servers so `x402HTTPResourceServer.initialize()`
//    sees a registered scheme for every `(scheme, network)` the seller
//    can emit — without these the foundation aborts at boot with
//    `RouteConfigurationError`.
paymentMiddlewareFromConfig(
  app,
  {
    'GET /api/widgets': {
      accepts: await inflowAccepts(seller, {
        price: '$0.01',
        schemes: ['exact'],
      }),
    },
    'POST /api/upload': {
      accepts: await inflowAccepts(seller, {
        price: '0.10 USDC',
        schemes: ['balance', 'exact'],
      }),
    },
  },
  [inflow],
  await inflowSchemeRegistrations(seller),
);

app.get('/api/widgets', async () => ({ widgets: [1, 2, 3] }));
app.post('/api/upload', async () => ({ status: 'received' }));
app.get('/free', async () => ({ ok: true, note: 'no payment required' }));

const port = Number(process.env['PORT'] ?? 3000);
await app.listen({ port });
console.log(`x402 seller listening on http://localhost:${port.toString()}`);
console.log(`  GET  /api/widgets  ($0.01)`);
console.log(`  POST /api/upload   (0.10 USDC)`);
console.log(`  GET  /free         (no payment)`);

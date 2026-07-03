import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { paymentMiddlewareFromConfig } from '@x402/hono';
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
//    Drops into the foundation's `facilitatorClients` array.
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });

// 2. Seller-authed client — owns `/v1/x402/config` and signer-discovery.
//    Drives `inflowAccepts`. Primes its caches at construction.
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = new Hono();

// `inflowSchemeRegistrations` ships passthrough scheme servers so
// `x402HTTPResourceServer.initialize()` sees a registered scheme for
// every `(scheme, network)` the seller can emit — without these the
// foundation aborts at boot with `RouteConfigurationError`.
app.use(
  '*',
  paymentMiddlewareFromConfig(
    {
      'GET /api/widgets': {
        accepts: await inflowAccepts(seller, { price: '$0.01' }),
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
  ),
);

app.get('/api/widgets', (c) => c.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', (c) => c.json({ status: 'received' }));
app.get('/free', (c) => c.json({ ok: true, note: 'no payment required' }));

const port = Number(process.env['PORT'] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`x402 seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  ($0.01)`);
  console.log(`  POST /api/upload   (0.10 USDC)`);
  console.log(`  GET  /free         (no payment)`);
});

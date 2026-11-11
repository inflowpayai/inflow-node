import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { paymentMiddlewareFromHTTPServer } from '@x402/hono';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  createInflowResourceServer,
  createInflowHTTPResourceServer,
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

const resourceServer = await createInflowResourceServer(seller, inflow);
app.use(
  '*',
  paymentMiddlewareFromHTTPServer(
    createInflowHTTPResourceServer(resourceServer, {
      'GET /api/widgets': async (context) => ({
        accepts: await inflowAccepts(seller, {
          price: context.adapter.getQueryParam?.('bundle') === 'large' ? '$0.05' : '$0.01',
        }),
      }),
      'POST /api/upload': async (context) => ({
        accepts: await inflowAccepts(seller, {
          price: context.adapter.getQueryParam?.('priority') === 'high' ? '0.20 USDC' : '0.10 USDC',
          schemes: ['balance', 'exact'],
        }),
      }),
    }),
  ),
);

app.get('/api/widgets', (c) => c.json({ widgets: [1, 2, 3] }));
app.post('/api/upload', (c) => c.json({ status: 'received' }));
app.get('/free', (c) => c.json({ ok: true, note: 'no payment required' }));

const port = Number(process.env['PORT'] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`x402 seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  ($0.01; ?bundle=large: $0.05)`);
  console.log(`  POST /api/upload   (0.10 USDC; ?priority=high: 0.20 USDC)`);
  console.log(`  GET  /free         (no payment)`);
});

import 'dotenv/config';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  createInflowResourceServer,
  createInflowHTTPResourceServer,
  inflowAccepts,
  inflowRoute,
} from '@inflowpayai/x402-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

// 1. Authed InFlow facilitator — `verify`, `settle`, `getSupported`.
//    Drops into the foundation's `facilitatorClients` array. The seller
//    can append other facilitators; InFlow must claim sponsored
//    (scheme, network) pairs before any competing facilitator.
const inflow = createInflowFacilitator({ environment: 'sandbox', apiKey });

// 2. Seller-authed client — owns `/v1/x402/config` and signer-discovery.
//    Drives `inflowAccepts`. Primes its caches in parallel at construction.
const seller = await createInflowSellerClient({ environment: 'sandbox', apiKey });

const app = express();
app.use(express.json());

// Prices come from the seller's price list, not an amount supplied by the buyer.
const server = await createInflowResourceServer(seller, [inflow]);
app.use(
  paymentMiddlewareFromHTTPServer(
    createInflowHTTPResourceServer(server, {
      'GET /api/widgets': async (context) => ({
        accepts: await inflowAccepts(seller, {
          price: context.adapter.getQueryParam?.('bundle') === 'large' ? '$0.05' : '$0.01',
          schemes: ['exact'],
        }),
      }),
      'GET /api/search': async (context) => ({
        accepts: await inflowAccepts(seller, {
          schemes: ['exact', 'balance'],
          price: {
            amount: context.adapter.getQueryParam?.('detail') === 'full' ? '0.25' : '0.10',
            currency: context.adapter.getQueryParam?.('currency') === 'USDT' ? 'USDT' : 'USDC',
          },
        }),
      }),
      'POST /api/upload': async (context) => ({
        accepts: await inflowAccepts(seller, {
          price: {
            amount: context.adapter.getQueryParam?.('priority') === 'high' ? '0.20' : '0.10',
            currency: 'USDC',
          },
          schemes: ['balance', 'exact'],
        }),
      }),
      'GET /api/report': async (context) => ({
        accepts: await inflowAccepts(seller, {
          price: context.adapter.getQueryParam?.('detail') === 'full' ? '0.25 USDC' : '0.10 USDC',
          schemes: ['balance', 'exact'],
          paymentFlow: 'upfront',
        }),
      }),
      'GET /api/sponsored': await inflowRoute(seller, {
        price: (context) => (context.adapter.getQueryParam?.('detail') === 'full' ? '0.02 USDC' : '0.01 USDC'),
        schemes: ['exact'],
        networks: ['eip155:84532'],
        assetTransferMethod: 'permit2',
      }),
    }),
  ),
);

app.get('/api/widgets', (_req, res) => {
  res.json({ widgets: [1, 2, 3] });
});

app.get('/api/search', (_req, res) => {
  res.json({ results: ['Sample search result'] });
});

app.get('/api/sponsored', (_req, res) => {
  res.json({ paid: true });
});

app.post('/api/upload', (_req, res) => {
  res.json({ status: 'received' });
});

// Payment has settled before this handler runs. A failed report is still paid;
// production job creation needs application idempotency and a recovery policy.
app.get('/api/report', (_req, res) => {
  res.json({ report: { title: 'Sample sales report', totalOrders: 42 } });
});

app.get('/free', (_req, res) => {
  res.json({ ok: true, note: 'no payment required' });
});

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  console.log(`x402 seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  ($0.01; ?bundle=large costs $0.05)`);
  console.log(`  GET  /api/search?detail=full&currency=USDT (request-time pricing; currencies must be configured)`);
  console.log(`  POST /api/upload   (0.10 USDC; ?priority=high costs 0.20 USDC)`);
  console.log(`  GET  /api/report   (0.10 USDC; ?detail=full costs 0.25 USDC, upfront)`);
  console.log(`  GET  /free         (no payment)`);
});

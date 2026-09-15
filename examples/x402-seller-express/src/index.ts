import 'dotenv/config';
import { paymentMiddlewareFromConfig } from '@x402/express';
import express from 'express';
import {
  createInflowFacilitator,
  createInflowSellerClient,
  inflowAccepts,
  inflowRoute,
  inflowSchemeRegistrations,
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

// 3. Foundation middleware + InFlow-built `PaymentOption[]` entries.
//    `inflowAccepts` expands the seller's config into AssetAmount-form
//    `accepts[]` (atomic amount + asset contract address pre-resolved).
//    `inflowSchemeRegistrations` ships passthrough scheme servers so
//    `x402HTTPResourceServer.initialize()` sees a registered scheme for
//    every `(scheme, network)` the seller can emit — without these the
//    foundation aborts at boot with `RouteConfigurationError`.
app.use(
  paymentMiddlewareFromConfig(
    {
      'GET /api/sponsored': await inflowRoute(seller, {
        price: '0.01 USDC',
        schemes: ['exact'],
        networks: ['eip155:84532'],
        assetTransferMethod: 'permit2',
      }),
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
  ),
);

app.get('/api/widgets', (_req, res) => {
  res.json({ widgets: [1, 2, 3] });
});

app.get('/api/sponsored', (_req, res) => {
  res.json({ paid: true });
});

app.post('/api/upload', (_req, res) => {
  res.json({ status: 'received' });
});

app.get('/free', (_req, res) => {
  res.json({ ok: true, note: 'no payment required' });
});

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  console.log(`x402 seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  ($0.01)`);
  console.log(`  POST /api/upload   (0.10 USDC)`);
  console.log(`  GET  /free         (no payment)`);
});

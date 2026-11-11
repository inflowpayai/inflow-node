import 'dotenv/config';
import express from 'express';
import { Mppx as MppxServer } from 'mppx/server';
import {
  inflow,
  inflowChargesNodeListener,
  inflowSubscriptionsNodeListener,
  paymentHttpTransport,
} from '@inflowpayai/mpp-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}
const baseUrl = process.env['INFLOW_BASE_URL'];

// One core instance handles single- and multi-currency prices through the Node listener helper.
const method = inflow({
  apiKey,
  environment: 'sandbox',
  ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
});
const secretKey = process.env['MPP_SECRET_KEY'];
const core = MppxServer.create({ methods: [method], secretKey, transport: paymentHttpTransport() });
const subscriptionMethod = inflow.subscription({
  apiKey,
  environment: 'sandbox',
  ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
});
const subscriptionCore = MppxServer.create({
  methods: [subscriptionMethod],
  secretKey,
  transport: paymentHttpTransport(),
});

const app = express();
app.use(express.json());

// Prices come from the seller's price list, not an amount supplied by the buyer.
const widgets = inflowChargesNodeListener(core, (request) => {
  const bundle = new URL(request.url ?? '/', 'http://localhost').searchParams.get('bundle');
  return [{ amount: bundle === 'large' ? '0.05' : '0.01', currency: 'USDC' }];
});
app.get('/api/widgets', async (req, res) => {
  const result = await widgets(req, res);
  if (result.status === 402) return;
  res.json({ widgets: [1, 2, 3] });
});

const upload = inflowChargesNodeListener(core, (request) => {
  const priority = new URL(request.url ?? '/', 'http://localhost').searchParams.get('priority');
  return [{ amount: priority === 'high' ? '0.20' : '0.10', currency: 'USDC' }];
});
app.post('/api/upload', async (req, res) => {
  const result = await upload(req, res);
  if (result.status === 402) return;
  res.json({ status: 'received' });
});

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
app.get('/api/subscribe', async (req, res) => {
  const result = await subscribe(req, res);
  if (result.status === 402) return;
  res.json({ subscribed: true });
});

// Multi-currency: one WWW-Authenticate challenge per price. USD settles on the `instrument` rail, USDC on `balance`;
// the buyer picks one. `inflowChargesNodeListener` returns a Node listener, mountable directly in an Express route.
const checkout = inflowChargesNodeListener(core, (request) => {
  const bundle = new URL(request.url ?? '/', 'http://localhost').searchParams.get('bundle');
  return [
    { amount: bundle === 'large' ? '2.00' : '1.00', currency: 'USD' },
    { amount: bundle === 'large' ? '0.019' : '0.0095', currency: 'USDC' },
  ];
});
app.get('/api/checkout', async (req, res) => {
  // On 402 the challenge response is already written; on 200 the receipt header is set, so we write the body.
  const result = await checkout(req, res);
  if (result.status === 402) {
    return;
  }
  res.json({ ok: true });
});

const search = inflowChargesNodeListener(core, (request) => {
  const detail = new URL(request.url ?? '/', 'http://localhost').searchParams.get('detail');
  return [
    { amount: detail === 'full' ? '1.00' : '0.50', currency: 'USD' },
    { amount: detail === 'full' ? '0.25' : '0.10', currency: 'USDC' },
  ];
});
app.get('/api/search', async (req, res) => {
  const result = await search(req, res);
  if (result.status === 402) return;
  res.json({ results: ['Sample search result'] });
});

app.get('/free', (_req, res) => {
  res.json({ ok: true, note: 'no payment required' });
});

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  console.log(`mpp seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  (0.01 USDC; ?bundle=large costs 0.05 USDC)`);
  console.log(`  POST /api/upload   (0.10 USDC; ?priority=high costs 0.20 USDC)`);
  console.log(`  GET  /api/subscribe (1.00 USDC each month)`);
  console.log(`  GET  /api/checkout (1.00 USD or 0.0095 USDC; ?bundle=large doubles the price)`);
  console.log(`  GET  /api/search?detail=full (request-time USD and USDC prices)`);
  console.log(`  GET  /free         (no payment)`);
});

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Mppx as MppxServer } from 'mppx/server';
import { inflow, inflowCharges, inflowSubscriptions, paymentHttpTransport } from '@inflowpayai/mpp-seller';

const apiKey = process.env['INFLOW_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  console.error('Set INFLOW_API_KEY in your environment (see .env.example).');
  process.exit(1);
}

const method = inflow({ apiKey, environment: 'sandbox' });
const secretKey = process.env['MPP_SECRET_KEY'];
const core = MppxServer.create({ methods: [method], secretKey, transport: paymentHttpTransport() });
const subscriptionMethod = inflow.subscription({ apiKey, environment: 'sandbox' });
const subscriptionCore = MppxServer.create({
  methods: [subscriptionMethod],
  secretKey,
  transport: paymentHttpTransport(),
});
const widgets = inflowCharges(core, (request) => [
  { amount: new URL(request.url).searchParams.get('bundle') === 'large' ? '0.05' : '0.01', currency: 'USDC' },
]);
const upload = inflowCharges(core, (request) => [
  { amount: new URL(request.url).searchParams.get('priority') === 'high' ? '0.20' : '0.10', currency: 'USDC' },
]);
const checkout = inflowCharges(core, (request) => {
  const large = new URL(request.url).searchParams.get('bundle') === 'large';
  return [
    { amount: large ? '2.0' : '1.0', currency: 'USD' },
    { amount: large ? '0.0190' : '0.0095', currency: 'USDC' },
  ];
});
const subscribe = inflowSubscriptions(subscriptionCore, [
  {
    amount: '1.00',
    currency: 'USDC',
    periodUnit: 'month',
    periodCount: 1,
    subscriptionExpires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    externalId: 'example-monthly-plan',
  },
]);

const app = new Hono();

// The rail is derived from the charge currency (crypto USDC → `balance`); the buyer never chooses it.
app.get('/api/widgets', async (c) => {
  const result = await widgets(c.req.raw);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(c.json({ widgets: [1, 2, 3] }));
});
app.post('/api/upload', async (c) => {
  const result = await upload(c.req.raw);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(c.json({ status: 'received' }));
});
app.get('/api/subscribe', async (c) => {
  const result = await subscribe(c.req.raw);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(c.json({ subscribed: true }));
});

// Multi-currency: one WWW-Authenticate challenge per price (USD on `instrument`, USDC on `balance`). On 402 return
// the challenge response; on 200 wrap the body with the receipt header via `withReceipt`.
app.get('/api/checkout', async (c) => {
  const result = await checkout(c.req.raw);
  if (result.status === 402) {
    return result.challenge;
  }
  return result.withReceipt(c.json({ ok: true }));
});

app.get('/free', (c) => c.json({ ok: true, note: 'no payment required' }));

const port = Number(process.env['PORT'] ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`mpp seller listening on http://localhost:${port.toString()}`);
  console.log(`  GET  /api/widgets  (0.01 USDC; ?bundle=large: 0.05 USDC)`);
  console.log(`  POST /api/upload   (0.10 USDC; ?priority=high: 0.20 USDC)`);
  console.log(`  GET  /api/subscribe (1.00 USDC each month)`);
  console.log(`  GET  /api/checkout (1.0 USD or 0.0095 USDC; ?bundle=large: 2.0 USD or 0.0190 USDC)`);
  console.log(`  GET  /free         (no payment)`);
});
